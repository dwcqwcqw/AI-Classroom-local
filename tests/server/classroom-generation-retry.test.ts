import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveModel: vi.fn(),
  isProviderKeyRequired: vi.fn(),
  generateSceneOutlinesFromRequirements: vi.fn(),
  applyOutlineFallbacks: vi.fn(),
  generateSceneContent: vi.fn(),
  generateSceneActions: vi.fn(),
  createSceneWithActions: vi.fn(),
  persistClassroom: vi.fn(),
  callLLM: vi.fn(),
}));
const PBLGenerationErrorMock = vi.hoisted(
  () =>
    class PBLGenerationError extends Error {
      readonly statusCode?: number;

      constructor(message: string, options?: { statusCode?: number }) {
        super(message);
        this.name = 'PBLGenerationError';
        this.statusCode = options?.statusCode;
      }
    },
);

vi.mock('@/lib/server/resolve-model', () => ({
  resolveModel: mocks.resolveModel,
}));

vi.mock('@/lib/ai/providers', async (importOriginal) => ({
  // The module graph now reaches the settings store (stage store -> settings),
  // whose init reads PROVIDERS - keep the real exports and stub only the probe.
  ...(await importOriginal<typeof import('@/lib/ai/providers')>()),
  isProviderKeyRequired: mocks.isProviderKeyRequired,
}));

vi.mock('@/lib/ai/llm', () => ({
  callLLM: mocks.callLLM,
}));

vi.mock('@openmaic/generation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@openmaic/generation')>()),
  generateSceneOutlinesFromRequirements: mocks.generateSceneOutlinesFromRequirements,
  applyOutlineFallbacks: mocks.applyOutlineFallbacks,
  generateSceneContent: mocks.generateSceneContent,
  generateSceneActions: mocks.generateSceneActions,
  PBLGenerationError: PBLGenerationErrorMock,
}));

vi.mock('@/lib/server/scene-generation', () => ({
  createSceneWithActions: mocks.createSceneWithActions,
}));

vi.mock('@/lib/server/classroom-storage', () => ({
  persistClassroom: mocks.persistClassroom,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const outline = {
  id: 'outline-1',
  type: 'slide',
  title: 'Retry Basics',
  description: 'Explain retries',
  keyPoints: ['Retry transient failures'],
  order: 1,
} as const;

const slideContent = {
  elements: [],
  remark: 'Retry transient failures',
};

async function generateWithProgress() {
  const progress: Array<{ message: string }> = [];
  const { generateClassroom } = await import('@/lib/server/classroom-generation');
  const result = await generateClassroom(
    { requirement: 'Teach retry basics' },
    {
      baseUrl: 'http://localhost',
      onProgress: (event) => {
        progress.push({ message: event.message });
      },
    },
  );
  return { result, progress };
}

describe('classroom scene generation retries', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) {
      mock.mockReset();
    }
    mocks.resolveModel.mockResolvedValue({
      model: { id: 'language-model' },
      modelInfo: {},
      modelString: 'test:model',
      providerId: 'test',
      apiKey: '',
    });
    mocks.isProviderKeyRequired.mockReturnValue(false);
    mocks.callLLM.mockResolvedValue({ text: 'ok' });
    mocks.generateSceneOutlinesFromRequirements.mockResolvedValue({
      success: true,
      data: {
        languageDirective: 'Use English.',
        outlines: [outline],
      },
    });
    mocks.applyOutlineFallbacks.mockImplementation((value) => value);
    mocks.generateSceneActions.mockResolvedValue([]);
    mocks.createSceneWithActions.mockImplementation((sceneOutline, content, actions, api) => {
      const sceneResult = api.scene.create({
        type: sceneOutline.type,
        title: sceneOutline.title,
        order: sceneOutline.order,
        content: {
          type: 'slide',
          canvas: {
            id: 'slide-1',
            viewportSize: 1000,
            viewportRatio: 0.5625,
            elements: content.elements,
          },
        },
        actions,
      });
      return sceneResult.success ? (sceneResult.data ?? null) : null;
    });
    mocks.persistClassroom.mockImplementation(async ({ id, scenes }) => ({
      id,
      url: `http://localhost/classroom/${id}`,
      scenesCount: scenes.length,
      createdAt: '2026-06-22T00:00:00.000Z',
    }));
  });

  it('selects the first allow-listed server model for headerless MCP generation', async () => {
    const {
      boundedGenerationOutputTokens,
      buildFastOutline,
      firstManagedServerModel,
      inferFocusedPageType,
      focusedInteractiveImplementationHint,
      focusedMobileImplementationHint,
      requestsSingleSlide,
      SCENE_CONTENT_TRANSIENT_MAX_RETRIES,
      sceneOutputTokenBudget,
    } = await import('@/lib/server/classroom-generation');

    expect(
      firstManagedServerModel({
        openai: { models: ['gpt-5.6-sol'] },
        qwen: { models: ['qwen-plus'] },
      }),
    ).toBe('openai:gpt-5.6-sol');
    expect(firstManagedServerModel({ openai: { models: [] } })).toBeUndefined();
    expect(boundedGenerationOutputTokens(128_000, 8_000)).toBe(8_000);
    expect(boundedGenerationOutputTokens(8_192, 16_000)).toBe(8_192);
    expect(boundedGenerationOutputTokens(undefined, 12_000)).toBe(12_000);
    expect(sceneOutputTokenBudget('slide')).toBe(2_400);
    expect(sceneOutputTokenBudget('interactive')).toBe(5_500);
    expect(sceneOutputTokenBudget('interactive', true)).toBe(4_800);
    expect(SCENE_CONTENT_TRANSIENT_MAX_RETRIES).toBe(5);
    expect(requestsSingleSlide('只生成一页PPT，介绍牛顿第二定律')).toBe(true);
    expect(requestsSingleSlide('Create a single slide about gravity')).toBe(true);
    expect(requestsSingleSlide('Create a ten-page course')).toBe(false);
    expect(inferFocusedPageType('生成一页量子隧穿的 3D 可视化')).toBe('visualization3d');
    expect(inferFocusedPageType('制作一页光合作用思维导图')).toBe('mindmap');
    expect(inferFocusedPageType('Build a single interactive simulation of gravity')).toBe(
      'simulation',
    );
    expect(focusedInteractiveImplementationHint('勾股定理动画')).toContain(
      'The central c² region is the ROTATED diamond',
    );
    expect(focusedInteractiveImplementationHint('量子隧穿动画')).toBe('');
    expect(focusedMobileImplementationHint('mindmap')).toContain('one-column nested outline/cards');
    expect(focusedMobileImplementationHint('simulation')).toContain(
      'controls in a wrapping grid above the visual',
    );
    expect(buildFastOutline('做一页牛顿第二定律游戏', 'game').outlines[0]).toMatchObject({
      type: 'interactive',
      widgetType: 'game',
    });
    expect(buildFastOutline('做一页 6 道量子力学测验', 'quiz').outlines[0]).toMatchObject({
      type: 'quiz',
      quizConfig: { questionCount: 6 },
    });
  });

  it('detects zero-argument helper functions used as numeric canvas values', async () => {
    const { focusedInteractiveRuntimeDefects } = await import('@/lib/server/classroom-generation');
    const broken = `<script>const c=()=>Math.sqrt(a*a+b*b);const scale=W/(a+b+c+1.2);</script>`;
    const working = `<script>const c=()=>Math.sqrt(a*a+b*b);const scale=W/(a+b+c()+1.2);</script>`;

    expect(focusedInteractiveRuntimeDefects(broken)).toEqual([
      'call numeric helper c() in arithmetic',
    ]);
    expect(focusedInteractiveRuntimeDefects(working)).toEqual([]);
  });

  it('rejects truncated interactive HTML before it can be published as a blank canvas', async () => {
    const { focusedInteractiveResponseDefects } = await import('@/lib/server/classroom-generation');
    const truncated = `<!doctype html><html><body><canvas id="c"></canvas><button id="go">开始</button><script>const c=document.getElementById('c');function draw(){c.getContext('2d').fillRect(0,0,10,10)};go.onclick=draw;`;

    expect(focusedInteractiveResponseDefects(truncated, 'length')).toEqual(
      expect.arrayContaining([
        'model response ended with finish reason length',
        'missing closing </html> tag',
        'missing closing </body> tag',
        'unbalanced script tags (1 open, 0 closed)',
      ]),
    );
  });

  it('rejects visible primary controls that were never wired up', async () => {
    const { focusedInteractiveResponseDefects } = await import('@/lib/server/classroom-generation');
    const unwired = `<!doctype html><html><body><button>开始</button><canvas></canvas><script>const ctx=document.querySelector('canvas').getContext('2d');ctx.fillRect(0,0,10,10)</script></body></html>`;

    expect(focusedInteractiveResponseDefects(unwired, 'stop')).toContain(
      'primary action buttons have no click or pointer handlers',
    );
  });

  it('falls back to one slide after a malformed outline response', async () => {
    mocks.generateSceneOutlinesFromRequirements
      .mockResolvedValueOnce({ success: false, error: 'Failed to parse scene outlines response' })
      .mockResolvedValueOnce({
        success: true,
        data: {
          languageDirective: 'Use English.',
          outlines: [outline],
        },
      });
    mocks.generateSceneContent.mockResolvedValue(slideContent);

    const { result, progress } = await generateWithProgress();

    expect(result.scenesCount).toBe(1);
    expect(mocks.generateSceneOutlinesFromRequirements).toHaveBeenCalledTimes(1);
    expect(progress.some((event) => event.message.includes('Retrying scene outlines'))).toBe(false);
  });

  it('publishes a fallback slide instead of retrying an empty scene result', async () => {
    mocks.generateSceneContent.mockResolvedValueOnce(null).mockResolvedValueOnce(slideContent);

    const { result, progress } = await generateWithProgress();

    expect(result.scenesCount).toBe(1);
    expect(result.scenes[0]?.type).toBe('slide');
    expect(mocks.generateSceneContent).toHaveBeenCalledTimes(1);
    expect(progress.some((event) => event.message.includes('Retrying scene 1/1 content'))).toBe(
      false,
    );
  });

  it('uses a bounded low-reasoning scene call from the first attempt', async () => {
    const thinkingConfig = { enabled: true, effort: 'high' };
    mocks.resolveModel.mockResolvedValue({
      model: { id: 'language-model' },
      modelInfo: {},
      modelString: 'test:model',
      providerId: 'test',
      apiKey: '',
      thinkingConfig,
    });
    mocks.generateSceneContent.mockImplementation(async (_outline, aiCall) => {
      await aiCall('system', 'user');
      return slideContent;
    });

    await generateWithProgress();

    expect(mocks.callLLM).toHaveBeenCalledWith(
      expect.objectContaining({
        maxRetries: 0,
        maxOutputTokens: 2_400,
        abortSignal: expect.any(AbortSignal),
      }),
      'generate-classroom-scene',
      undefined,
      expect.objectContaining({ mode: 'enabled', enabled: true, effort: 'low' }),
    );
  });

  it('preserves an explicit disabled-thinking route for low-latency generation', async () => {
    mocks.resolveModel.mockResolvedValue({
      model: { id: 'language-model' },
      modelInfo: {},
      modelString: 'deepseek:deepseek-v4-pro',
      providerId: 'deepseek',
      apiKey: 'server-managed-key',
      thinkingConfig: { mode: 'disabled', enabled: false, effort: 'high' },
    });
    mocks.generateSceneContent.mockImplementation(async (_outline, aiCall) => {
      await aiCall('system', 'user');
      return slideContent;
    });

    await generateWithProgress();

    expect(mocks.callLLM).toHaveBeenCalledWith(
      expect.objectContaining({ maxRetries: 0, maxOutputTokens: 2_400 }),
      'generate-classroom-scene',
      undefined,
      expect.objectContaining({ mode: 'disabled', enabled: false }),
    );
    expect(mocks.callLLM.mock.calls.at(-1)?.[3]).toHaveProperty('effort', undefined);
  });

  it('does not launch a second long upstream scene request', async () => {
    const thinkingConfig = { enabled: true, effort: 'medium' };
    mocks.resolveModel.mockResolvedValue({
      model: { id: 'language-model' },
      modelInfo: { outputWindow: 128_000 },
      modelString: 'test:model',
      providerId: 'test',
      apiKey: '',
      thinkingConfig,
    });
    mocks.generateSceneContent
      .mockImplementationOnce(async (_outline, aiCall) => {
        await aiCall('system', 'user');
        return null;
      })
      .mockImplementationOnce(async (_outline, aiCall) => {
        await aiCall('system', 'user');
        return slideContent;
      });

    await generateWithProgress();

    expect(mocks.callLLM).toHaveBeenCalledTimes(1);
    expect(mocks.generateSceneContent).toHaveBeenCalledTimes(1);
  });

  it('retries a transient upstream connect timeout and completes the scene', async () => {
    mocks.generateSceneContent
      .mockRejectedValueOnce(
        new Error(
          'Cannot connect to API: Connect Timeout Error (attempted address: apihub.bookln.cn:443, timeout: 10000ms)',
        ),
      )
      .mockResolvedValueOnce(slideContent);

    const { result, progress } = await generateWithProgress();

    expect(result.scenesCount).toBe(1);
    expect(mocks.generateSceneContent).toHaveBeenCalledTimes(2);
    expect(progress.some((event) => event.message.includes('Retrying scene 1/1 content'))).toBe(
      true,
    );
  });

  it('does not retry a non-retryable scene content error', async () => {
    mocks.generateSceneContent.mockRejectedValueOnce(
      Object.assign(new Error('Unauthorized'), { statusCode: 401 }),
    );

    const { result, progress } = await generateWithProgress();

    expect(result.scenesCount).toBe(1);
    expect(mocks.generateSceneContent).toHaveBeenCalledTimes(1);
    expect(progress.some((event) => event.message.includes('Retrying scene 1/1 content'))).toBe(
      false,
    );
  });

  it('publishes content without narration when action generation fails', async () => {
    mocks.generateSceneContent.mockResolvedValue(slideContent);
    mocks.generateSceneActions
      .mockRejectedValueOnce(Object.assign(new Error('rate limited'), { statusCode: 429 }))
      .mockResolvedValueOnce([]);

    const { result, progress } = await generateWithProgress();

    expect(result.scenesCount).toBe(1);
    expect(mocks.generateSceneActions).toHaveBeenCalledTimes(1);
    expect(progress.some((event) => event.message.includes('Retrying scene 1/1 actions'))).toBe(
      false,
    );
  });

  it('does not let a non-retryable action error block later scenes', async () => {
    const outlines = [
      { ...outline, id: 'outline-slide-1', title: 'Opening slide', order: 0 },
      { ...outline, id: 'outline-broken', title: 'Broken slide', order: 1 },
      { ...outline, id: 'outline-slide-2', title: 'Closing slide', order: 2 },
    ];
    const unauthorized = Object.assign(new Error('Unauthorized'), { statusCode: 401 });
    mocks.generateSceneOutlinesFromRequirements.mockResolvedValue({
      success: true,
      data: { languageDirective: 'Use English.', outlines },
    });
    mocks.generateSceneContent.mockResolvedValue(slideContent);
    mocks.generateSceneActions.mockImplementation(async (sceneOutline) => {
      if (sceneOutline.id === 'outline-broken') throw unauthorized;
      return [];
    });

    const { result, progress } = await generateWithProgress();

    expect(result.scenesCount).toBe(3);
    expect(result.scenes.map((scene) => scene.title)).toEqual([
      'Opening slide',
      'Broken slide',
      'Closing slide',
    ]);
    expect(mocks.generateSceneActions).toHaveBeenCalledTimes(3);
    expect(progress.some((event) => event.message.includes('Skipped failed scene 2/3'))).toBe(
      false,
    );
  });

  it('converts only PBLGenerationError to a null scene result', async () => {
    const { containPBLGenerationError } = await import('@/lib/server/classroom-generation');

    expect(
      containPBLGenerationError(
        new PBLGenerationErrorMock('both planners failed'),
        'Failed PBL scene',
      ),
    ).toBeNull();

    const unrelated = new Error('unrelated failure');
    expect(() => containPBLGenerationError(unrelated, 'Other scene')).toThrow(unrelated);
  });

  it('does not retry a status-less PBL failure and completes surrounding slides', async () => {
    const outlines = [
      { ...outline, id: 'outline-slide-1', title: 'Opening slide', order: 0 },
      {
        ...outline,
        id: 'outline-pbl',
        type: 'pbl' as const,
        title: 'Practice project',
        order: 1,
        pblConfig: {
          projectTopic: 'Retries',
          projectDescription: 'Practice resilient generation',
          targetSkills: ['Retry handling'],
        },
      },
      { ...outline, id: 'outline-slide-2', title: 'Closing slide', order: 2 },
    ];
    mocks.generateSceneOutlinesFromRequirements.mockResolvedValue({
      success: true,
      data: { languageDirective: 'Use English.', outlines },
    });
    mocks.generateSceneContent.mockImplementation(async (sceneOutline) => {
      if (sceneOutline.type === 'pbl') {
        throw new PBLGenerationErrorMock('both planners failed');
      }
      return slideContent;
    });

    const { result } = await generateWithProgress();
    const pblCalls = mocks.generateSceneContent.mock.calls.filter(
      ([sceneOutline]) => sceneOutline.type === 'pbl',
    );

    expect(result.scenesCount).toBe(3);
    expect(result.scenes.map((scene) => scene.title)).toEqual([
      'Opening slide',
      'Practice project',
      'Closing slide',
    ]);
    expect(pblCalls).toHaveLength(1);
  });

  it('does not retry a 401 PBL failure and completes surrounding slides', async () => {
    const outlines = [
      { ...outline, id: 'outline-slide-1', title: 'Opening slide', order: 0 },
      {
        ...outline,
        id: 'outline-pbl',
        type: 'pbl' as const,
        title: 'Practice project',
        order: 1,
        pblConfig: {
          projectTopic: 'Retries',
          projectDescription: 'Practice resilient generation',
          targetSkills: ['Retry handling'],
        },
      },
      { ...outline, id: 'outline-slide-2', title: 'Closing slide', order: 2 },
    ];
    mocks.generateSceneOutlinesFromRequirements.mockResolvedValue({
      success: true,
      data: { languageDirective: 'Use English.', outlines },
    });
    mocks.generateSceneContent.mockImplementation(async (sceneOutline) => {
      if (sceneOutline.type === 'pbl') {
        throw new PBLGenerationErrorMock('provider key rejected', { statusCode: 401 });
      }
      return slideContent;
    });

    const { result } = await generateWithProgress();
    const pblCalls = mocks.generateSceneContent.mock.calls.filter(
      ([sceneOutline]) => sceneOutline.type === 'pbl',
    );

    expect(result.scenesCount).toBe(3);
    expect(result.scenes.map((scene) => scene.title)).toEqual([
      'Opening slide',
      'Practice project',
      'Closing slide',
    ]);
    expect(pblCalls).toHaveLength(1);
  });

  it('bounds a 429 PBL retry before skipping it and completing surrounding slides', async () => {
    vi.useFakeTimers();
    try {
      const outlines = [
        { ...outline, id: 'outline-slide-1', title: 'Opening slide', order: 0 },
        {
          ...outline,
          id: 'outline-pbl',
          type: 'pbl' as const,
          title: 'Practice project',
          order: 1,
          pblConfig: {
            projectTopic: 'Retries',
            projectDescription: 'Practice resilient generation',
            targetSkills: ['Retry handling'],
          },
        },
        { ...outline, id: 'outline-slide-2', title: 'Closing slide', order: 2 },
      ];
      mocks.generateSceneOutlinesFromRequirements.mockResolvedValue({
        success: true,
        data: { languageDirective: 'Use English.', outlines },
      });
      mocks.generateSceneContent.mockImplementation(async (sceneOutline) => {
        if (sceneOutline.type === 'pbl') {
          throw new PBLGenerationErrorMock('provider rate limited', { statusCode: 429 });
        }
        return slideContent;
      });

      const generation = generateWithProgress();
      await vi.runAllTimersAsync();
      const { result } = await generation;
      const pblCalls = mocks.generateSceneContent.mock.calls.filter(
        ([sceneOutline]) => sceneOutline.type === 'pbl',
      );

      expect(result.scenesCount).toBe(3);
      expect(result.scenes.map((scene) => scene.title)).toEqual([
        'Opening slide',
        'Practice project',
        'Closing slide',
      ]);
      expect(pblCalls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
