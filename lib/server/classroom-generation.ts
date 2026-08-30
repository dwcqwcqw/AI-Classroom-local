import { nanoid } from 'nanoid';
import { callLLM } from '@/lib/ai/llm';
import { createStageAPI } from '@/lib/api/stage-api';
import type { StageStore } from '@/lib/api/stage-api-types';
import {
  applyOutlineFallbacks,
  generateSceneOutlinesFromRequirements,
  generateSceneActions,
  generateSceneContent,
  PBLGenerationError,
  withGenerationRetry,
  type AICallFn,
  type AgentInfo,
  type GeneratedSceneContent,
  type SceneOutline,
} from '@openmaic/generation';
import { createSceneWithActions } from '@/lib/server/scene-generation';
import { generatePBLV2Project } from '@/lib/pbl/v2/agents/planner';
import { getDefaultAgents } from '@/lib/orchestration/registry/store';
import { createLogger } from '@/lib/logger';
import { isProviderKeyRequired } from '@/lib/ai/providers';
import { getServerProviders } from '@/lib/server/provider-config';
import { resolveClassroomWebSearchConfig } from '@/lib/server/web-search-config';
import { resolveModel } from '@/lib/server/resolve-model';
import { getStageModel, type LlmStage } from '@/lib/server/model-routes';
import type { LanguageModel } from 'ai';
import type { ThinkingConfig } from '@/lib/types/provider';
import { resolveVocationalActive } from '@/lib/config/feature-flags';
import { buildSearchQuery } from '@/lib/server/search-query-builder';
import { formatSearchResultsAsContext, searchWeb } from '@/lib/web-search';
import type { BaiduSubSources, WebSearchProviderId } from '@/lib/web-search/types';
import { persistClassroom } from '@/lib/server/classroom-storage';
import {
  generateMediaForClassroom,
  replaceMediaPlaceholders,
  generateTTSForClassroom,
} from '@/lib/server/classroom-media-generation';
import { buildVideoManifestFromOutlines } from '@/lib/media/video-manifest';
import type { FocusedPageType, UserRequirements } from '@/lib/types/generation';
import type { Scene, Stage } from '@/lib/types/stage';
import type { Action } from '@/lib/types/action';
import { AGENT_COLOR_PALETTE, AGENT_DEFAULT_AVATARS } from '@/lib/constants/agent-defaults';

const log = createLogger('Classroom');

/**
 * One-page interactive generation targets 30 seconds, but 30 seconds is an
 * observability target rather than a quality-damaging cutoff. The longer
 * timeout only protects workers from a genuinely stalled upstream gateway.
 */
export const SCENE_GENERATION_TARGET_MS = 30_000;
// A focused page normally finishes in one call. Keep enough room for one clean
// regeneration when the gateway reports a truncated response: publishing a
// half-written canvas is worse than taking another minute to return a working
// lesson. Each individual upstream call is still capped below.
export const SCENE_GENERATION_BUDGET_MS = 135_000;
export const SCENE_CONTENT_BUDGET_MS = 65_000;
export const SCENE_CONTENT_TRANSIENT_MAX_RETRIES = 5;
const MIN_ACTION_BUDGET_MS = 1_000;

const FOCUSED_INTERACTIVE_SYSTEM_PROMPT = `Create one compact, self-contained HTML5 educational widget from the user brief.

Return ONLY one complete HTML document beginning with <!DOCTYPE html> and ending with </html>. Do not use markdown fences or explanations.

HARD SIZE LIMIT: the entire response must be at most 6,000 characters. This is more important than visual decoration. Use short identifiers, no comments, no repeated markup, no SVG path dumps, no verbose labels, and no optional features. Finish all JavaScript and closing tags before the limit. Aim for 3,500-4,500 characters.

Requirements:
- Use concise vanilla HTML, CSS, and JavaScript. Prefer one canvas plus a compact controls panel. Avoid dependencies unless the requested 3D effect truly requires one.
- Implement the requested interaction and visualization; controls must update the result immediately.
- Include <script type="application/json" id="widget-config"> with a small valid JSON object describing the widget type and variables.
- Mobile is a first-class layout, not a scaled desktop screenshot. The page must work at 320x568 and 390x844 with no horizontal page scrolling, clipped text, overlapping labels/nodes, or controls outside the viewport.
- Include a viewport meta tag. Use max-width:100%, border-box sizing, wrapping text, auto-height content, and an explicit @media(max-width:600px) layout. Never use a fixed min-width or fixed-position content that can cover the lesson.
- On phones, stack controls before the visualization; never hide start, pause, or reset controls. Touch targets must be at least 44px and remain above the safe-area inset.
- Canvas/SVG must resize with its container. SVG should use a viewBox; canvas must derive its drawing size from its rendered container. Start, pause, and reset must work when relevant.
- Use Chinese UI when the brief is Chinese.
- Mentally execute the initial render before returning. Every canvas coordinate and scale must be finite; call numeric helper functions (for example c()) instead of using the function object (c) in arithmetic.
- Prefer a complete working implementation and closing tags over decorative CSS, long prose, presets, keyboard shortcuts, annotations, or postMessage integration.`;

export function focusedInteractiveImplementationHint(requirement: string): string {
  if (!/(?:勾股|pythagor)/i.test(requirement)) return '';

  return `\n\nExact construction for the Pythagorean animation (do not improvise it): use a square SVG viewBox 0 0 S S where S=a+b. View 1: draw the four congruent right triangles with vertices [(0,0),(a,0),(0,b)], [(a,0),(S,0),(S,a)], [(S,a),(S,S),(b,S)], and [(b,S),(0,S),(0,b)]. The central c² region is the ROTATED diamond [(a,0),(S,a),(b,S),(0,b)]; never cover the triangles with an axis-aligned square. View 2: tile the SAME outer square completely: draw the a² square [(0,0),(a,0),(a,a),(0,a)] and b² square [(a,a),(S,a),(S,S),(a,S)]. The remaining top-right a×b rectangle and bottom-left a×b rectangle must each be split by a diagonal into two of the same triangles. Shared vertices must be identical: no gaps, overlaps, white holes, rectangles mislabeled as squares, or shapes outside the outer square. Use SVG polygons and recompute every point when a or b changes.`;
}

export function focusedMobileImplementationHint(pageType: FocusedPageType | undefined): string {
  const shared = `\n\nMobile acceptance contract: verify the finished widget at 360px CSS width. No element may extend past the viewport. Text must wrap without clipping, every primary action must remain visible, and the learning interaction must remain usable by touch. Use a real @media(max-width:600px) reflow rather than transform:scale().`;
  if (pageType === 'mindmap') {
    return `${shared} For a mind map, do NOT squeeze a desktop node graph onto the phone. At <=600px render the same hierarchy as a one-column nested outline/cards (collapsible is allowed), with normal document flow, auto-height nodes, wrapped labels, and indentation for parent-child depth. Hide or simplify connector lines on mobile. Never absolutely position mind-map nodes on mobile.`;
  }
  if (pageType === 'visualization3d' || pageType === 'simulation' || pageType === 'game') {
    return `${shared} Put controls in a wrapping grid above the visual. Give the visual a bounded responsive aspect-ratio and recompute its canvas/SVG dimensions after resize; do not crop the active area.`;
  }
  return shared;
}

function executableScriptText(html: string): string {
  return Array.from(html.matchAll(/<script(?![^>]*application\/json)[^>]*>([\s\S]*?)<\/script>/gi))
    .map((match) => match[1])
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n\r]*/g, '')
    .replace(/(['"`])(?:\\.|(?!\1)[\s\S])*?\1/g, '');
}

/** Catch a common silent-canvas failure that is valid JavaScript but produces NaN coordinates. */
export function focusedInteractiveRuntimeDefects(html: string): string[] {
  const script = executableScriptText(html);
  const zeroArgHelpers = Array.from(
    script.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\(\s*\)\s*=>/g),
    (match) => match[1],
  );
  const defects: string[] = [];

  for (const helper of zeroArgHelpers) {
    const escaped = helper.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const usedAsValue = new RegExp(
      `(?:[+\\-*/%]\\s*${escaped}\\b(?!\\s*\\()|\\b${escaped}\\b(?!\\s*\\()\\s*[+\\-*/%])`,
    );
    if (usedAsValue.test(script)) defects.push(`call numeric helper ${helper}() in arithmetic`);
  }

  return defects;
}

/** Reject responses that look like HTML but cannot be a complete live widget. */
export function focusedInteractiveResponseDefects(html: string, finishReason?: string): string[] {
  const defects = focusedInteractiveRuntimeDefects(html);
  const normalizedFinish = finishReason?.trim().toLowerCase();

  if (normalizedFinish && normalizedFinish !== 'stop') {
    defects.unshift(`model response ended with finish reason ${finishReason}`);
  }

  if (!/<\/html\s*>/i.test(html)) defects.push('missing closing </html> tag');
  if (!/<\/body\s*>/i.test(html)) defects.push('missing closing </body> tag');

  const scriptStarts = html.match(/<script\b[^>]*>/gi)?.length ?? 0;
  const scriptEnds = html.match(/<\/script\s*>/gi)?.length ?? 0;
  if (scriptStarts !== scriptEnds) {
    defects.push(`unbalanced script tags (${scriptStarts} open, ${scriptEnds} closed)`);
  }

  const hasPrimaryButtons =
    /<button\b[^>]*>[\s\S]{0,80}(?:start|run|play|pause|reset|restart|开始|启动|运行|暂停|重置)/i.test(
      html,
    );
  const hasButtonBinding =
    /\bon(?:click|pointerdown|touchstart)\s*=|\.on(?:click|pointerdown|touchstart)\s*=|addEventListener\s*\(\s*['"](?:click|pointerdown|touchstart)['"]/i.test(
      html,
    );
  if (hasPrimaryButtons && !hasButtonBinding) {
    defects.push('primary action buttons have no click or pointer handlers');
  }

  return Array.from(new Set(defects));
}

function remainingBudgetMs(deadlineAt: number, ceilingMs: number): number {
  return Math.max(1, Math.min(ceilingMs, deadlineAt - Date.now()));
}

function generationFastThinkingConfig(thinking: ThinkingConfig | undefined): ThinkingConfig {
  // Respect an explicit low-latency route override. Some providers (notably
  // DeepSeek V4 Pro) map `low` reasoning back to `high`, so turning a disabled
  // route into enabled/low silently defeats the fast path and can consume the
  // entire page budget.
  if (thinking?.mode === 'disabled' || thinking?.enabled === false) {
    return {
      ...thinking,
      mode: 'disabled',
      enabled: false,
      effort: undefined,
      budgetTokens: undefined,
    };
  }

  return {
    ...thinking,
    mode: 'enabled',
    enabled: true,
    effort: 'low',
    budgetTokens: undefined,
  };
}

export function sceneOutputTokenBudget(type?: string, focusedSinglePage = false): number {
  switch (type) {
    case 'interactive':
      // Focused mode replaces the legacy verbose user template as well as the
      // system prompt. Leave headroom for code-heavy Chinese widgets so the
      // gateway can emit the closing initialization and HTML tags.
      return focusedSinglePage ? 4_800 : 5_500;
    case 'pbl':
      return 3_000;
    case 'quiz':
      return 1_800;
    default:
      return 2_400;
  }
}

export function requestsSingleSlide(requirement: string): boolean {
  return /(?:只|仅)?(?:生成|制作|做)?\s*(?:一|1)\s*页|(?:一|1)\s*页\s*(?:PPT|幻灯片)|\b(?:one|single)\s+(?:page|slide)\b/i.test(
    requirement,
  );
}

export function inferFocusedPageType(requirement: string): FocusedPageType | undefined {
  if (
    /(?:3\s*d|three[- ]?dimensional|三维)(?:\s*(?:visuali[sz]ation|可视化|模型))?|visuali[sz]ation\s*3\s*d/i.test(
      requirement,
    )
  ) {
    return 'visualization3d';
  }
  if (/(?:mind\s*map|mindmap|思维导图|心智图|脑图)/i.test(requirement)) return 'mindmap';
  if (/(?:interactive\s*)?(?:simulation|simulator)|互动模拟|仿真|模拟实验/i.test(requirement)) {
    return 'simulation';
  }
  if (/(?:educational\s*)?game|互动游戏|教学游戏|小游戏|闯关/i.test(requirement)) return 'game';
  if (/(?:quiz|test|测验|测试|答题|问答|选择题)/i.test(requirement)) return 'quiz';
  return undefined;
}

function inferVisualizationType(
  requirement: string,
): NonNullable<NonNullable<SceneOutline['widgetOutline']>['visualizationType']> {
  if (/分子|molecul/i.test(requirement)) return 'molecular';
  if (/太阳系|行星|solar|planet/i.test(requirement)) return 'solar';
  if (/解剖|器官|anatom/i.test(requirement)) return 'anatomy';
  if (/几何|geometr/i.test(requirement)) return 'geometry';
  if (/物理|physics|力学|波|电磁/i.test(requirement)) return 'physics';
  return 'custom';
}

export function buildFastOutline(
  requirement: string,
  pageType?: FocusedPageType,
): {
  languageDirective: string;
  courseTitle: string;
  outlines: SceneOutline[];
} {
  const normalized = requirement.replace(/\s+/g, ' ').trim();
  const clauses = normalized
    .split(/[。！？!?；;\n]/)
    .map((part) => part.trim())
    .filter(Boolean);
  const titleSource = clauses[0] || normalized || '课程要点';
  const title = titleSource.length > 42 ? `${titleSource.slice(0, 39)}…` : titleSource;
  const keyPoints = clauses.slice(1, 6);

  const baseOutline: SceneOutline = {
    id: nanoid(10),
    type: 'slide',
    title,
    description: normalized,
    keyPoints: keyPoints.length > 0 ? keyPoints : [normalized],
    order: 0,
  };

  let outline = baseOutline;
  if (pageType === 'quiz') {
    const requestedCount = normalized.match(
      /(?:^|\D)([1-9]|1\d|20)\s*(?:道|个)?[^。！？!?]{0,12}(?:题|测验|测试|questions?)/i,
    )?.[1];
    outline = {
      ...baseOutline,
      type: 'quiz',
      quizConfig: {
        questionCount: requestedCount ? Number(requestedCount) : 4,
        difficulty: /困难|进阶|hard|advanced/i.test(normalized) ? 'hard' : 'medium',
        questionTypes: ['single', 'multiple'],
      },
    };
  } else if (pageType) {
    const widgetType = pageType === 'mindmap' ? 'diagram' : pageType;
    outline = {
      ...baseOutline,
      type: 'interactive',
      widgetType,
      widgetOutline: {
        concept: title,
        ...(pageType === 'mindmap' ? { diagramType: 'mindmap' as const, nodeCount: 8 } : {}),
        ...(pageType === 'game'
          ? {
              gameType: 'action' as const,
              challenge: normalized,
              playerControls: ['触摸', '拖拽', '点击'],
            }
          : {}),
        ...(pageType === 'simulation'
          ? { keyVariables: [], interactions: ['调节参数', '启动/暂停', '重置'] }
          : {}),
        ...(pageType === 'visualization3d'
          ? {
              visualizationType: inferVisualizationType(normalized),
              objects: [],
              interactions: ['旋转视角', '缩放', '播放/暂停动画', '重置'],
            }
          : {}),
      },
    };
  }

  return {
    languageDirective: '使用与用户要求一致的语言，表达清晰、简洁，适合目标学习者。',
    courseTitle: title,
    outlines: [outline],
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Last-resort, topic-agnostic page. This is deliberately built from the model's
 * outline rather than hardcoded subject matter: a single slow provider may
 * reduce richness, but can no longer make the entire course fail.
 */
export function buildTimedOutSceneFallback(outline: SceneOutline): {
  outline: SceneOutline;
  content: GeneratedSceneContent;
  actions: Action[];
} {
  const points = (outline.keyPoints ?? []).filter(Boolean).slice(0, 5);
  const body = points.length > 0 ? points : [outline.description || '本页内容正在后台完善中'];
  const bulletHtml = body
    .map((point) => `<p style="margin:0 0 14px 0">• ${escapeHtml(point)}</p>`)
    .join('');

  return {
    outline: {
      ...outline,
      type: 'slide',
      title: outline.title || '课程要点',
    },
    content: {
      background: { type: 'solid', color: '#F7FAFF' },
      remark: outline.description || '',
      elements: [
        {
          id: `fallback-title-${outline.id}`,
          type: 'text',
          left: 64,
          top: 54,
          width: 872,
          height: 80,
          content: `<p style="font-size:34px;font-weight:700;margin:0">${escapeHtml(outline.title || '课程要点')}</p>`,
          defaultFontName: 'Microsoft YaHei',
          defaultColor: '#102A56',
          rotate: 0,
        },
        {
          id: `fallback-body-${outline.id}`,
          type: 'text',
          left: 86,
          top: 164,
          width: 828,
          height: 326,
          content: bulletHtml,
          defaultFontName: 'Microsoft YaHei',
          defaultColor: '#24415F',
          rotate: 0,
        },
      ],
    },
    actions: [],
  };
}

export function firstManagedServerModel(
  providers: Record<string, { models?: string[] }>,
): string | undefined {
  for (const [providerId, provider] of Object.entries(providers)) {
    const modelId = provider.models?.find((model) => model.trim().length > 0);
    if (modelId) return `${providerId}:${modelId}`;
  }
  return undefined;
}

export function boundedGenerationOutputTokens(
  outputWindow: number | undefined,
  ceiling: number,
): number {
  if (!outputWindow || !Number.isFinite(outputWindow) || outputWindow <= 0) return ceiling;
  return Math.min(Math.floor(outputWindow), ceiling);
}

export function containPBLGenerationError(error: unknown, sceneTitle: string): null {
  if (!(error instanceof PBLGenerationError)) throw error;
  log.warn(`PBL generation failed for scene "${sceneTitle}": ${error.message}`);
  return null;
}

export interface GenerateClassroomInput {
  requirement: string;
  pageType?: FocusedPageType;
  pdfContent?: { text: string; images: string[] };
  enableWebSearch?: boolean;
  webSearchProviderId?: WebSearchProviderId;
  webSearchApiKey?: string;
  webSearchModelId?: string;
  baiduSubSources?: BaiduSubSources;
  enableImageGeneration?: boolean;
  enableVideoGeneration?: boolean;
  enableTTS?: boolean;
  agentMode?: 'default' | 'generate';
}

export type ClassroomGenerationStep =
  | 'initializing'
  | 'researching'
  | 'generating_outlines'
  | 'generating_scenes'
  | 'generating_media'
  | 'generating_tts'
  | 'persisting'
  | 'completed';

export interface ClassroomGenerationProgress {
  step: ClassroomGenerationStep;
  progress: number;
  message: string;
  scenesGenerated: number;
  totalScenes?: number;
}

export interface GenerateClassroomResult {
  id: string;
  url: string;
  stage: Stage;
  scenes: Scene[];
  scenesCount: number;
  createdAt: string;
}

function createInMemoryStore(stage: Stage): StageStore {
  let state = {
    stage: stage as Stage | null,
    scenes: [] as Scene[],
    currentSceneId: null as string | null,
    mode: 'playback' as const,
  };

  const listeners: Array<(s: typeof state, prev: typeof state) => void> = [];

  return {
    getState: () => state,
    setState: (partial: Partial<typeof state>) => {
      const prev = state;
      state = { ...state, ...partial };
      listeners.forEach((fn) => fn(state, prev));
    },
    subscribe: (listener: (s: typeof state, prev: typeof state) => void) => {
      listeners.push(listener);
      return () => {
        const idx = listeners.indexOf(listener);
        if (idx >= 0) listeners.splice(idx, 1);
      };
    },
  };
}

function stripCodeFences(text: string): string {
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }
  return cleaned.trim();
}

async function generateAgentProfiles(
  requirement: string,
  languageDirective: string,
  aiCall: AICallFn,
): Promise<AgentInfo[]> {
  const systemPrompt =
    'You are an expert instructional designer. Generate agent profiles for a multi-agent classroom simulation. Return ONLY valid JSON, no markdown or explanation.';

  const userPrompt = `Generate agent profiles for a course with this requirement:
${requirement}

Requirements:
- Decide the appropriate number of agents based on the course content (typically 3-5)
- Exactly 1 agent must have role "teacher", the rest can be "assistant" or "student"
- Each agent needs: name, role, persona (2-3 sentences describing personality and teaching/learning style)
- Language directive for this course: ${languageDirective}
  Agent names and personas must follow this language directive.

Return a JSON object with this exact structure:
{
  "agents": [
    {
      "name": "string",
      "role": "teacher" | "assistant" | "student",
      "persona": "string (2-3 sentences)"
    }
  ]
}`;

  const response = await aiCall(systemPrompt, userPrompt);
  const rawText = stripCodeFences(response);
  const parsed = JSON.parse(rawText) as {
    agents: Array<{ name: string; role: string; persona: string }>;
  };

  if (!parsed.agents || !Array.isArray(parsed.agents) || parsed.agents.length < 2) {
    throw new Error(`Expected at least 2 agents, got ${parsed.agents?.length ?? 0}`);
  }

  const teacherCount = parsed.agents.filter((a) => a.role === 'teacher').length;
  if (teacherCount !== 1) {
    throw new Error(`Expected exactly 1 teacher, got ${teacherCount}`);
  }

  return parsed.agents.map((a, i) => ({
    id: `gen-server-${i}`,
    name: a.name,
    role: a.role,
    persona: a.persona,
  }));
}

export async function generateClassroom(
  input: GenerateClassroomInput,
  options: {
    baseUrl: string;
    onProgress?: (progress: ClassroomGenerationProgress) => Promise<void> | void;
  },
): Promise<GenerateClassroomResult> {
  const { requirement, pdfContent } = input;

  await options.onProgress?.({
    step: 'initializing',
    progress: 5,
    message: 'Initializing classroom generation',
    scenesGenerated: 0,
  });

  const {
    model: languageModel,
    modelInfo,
    modelString,
    providerId,
    apiKey,
    thinkingConfig: classroomThinking,
  } = await resolveModel({
    stage: 'generate-classroom',
    // MCP/background calls do not carry the browser's x-model header. When the
    // operator omitted DEFAULT_MODEL, use the first explicitly allow-listed
    // server-managed model rather than failing before outline generation.
    modelString: process.env.DEFAULT_MODEL
      ? undefined
      : firstManagedServerModel(getServerProviders()),
  });
  log.info(`Using server-configured model: ${modelString}`);

  // Fail fast if the resolved provider has no API key configured
  if (isProviderKeyRequired(providerId) && !apiKey) {
    throw new Error(
      `No API key configured for provider "${providerId}". ` +
        `Set the appropriate key in .env.local or server-providers.yml (e.g. ${providerId.toUpperCase()}_API_KEY).`,
    );
  }

  // The web-search query rewrite is a light, separable stage operators may route
  // to a cheaper model. It defaults to the classroom model and is only
  // re-resolved lazily (inside the web-search branch, and only when a route is
  // configured). This keeps a misconfigured optional route from aborting all
  // classroom generation, and skips the extra resolution when web search is off.
  let searchQueryModel = languageModel;
  let searchQueryThinking = classroomThinking;

  const aiCall: AICallFn = async (systemPrompt, userPrompt, _images) => {
    const result = await callLLM(
      {
        model: languageModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        // An outline is compact structured JSON. Passing a provider's full
        // 128k output window encourages unnecessarily long generations and
        // makes OpenAI-compatible gateways much more likely to time out.
        maxOutputTokens: boundedGenerationOutputTokens(modelInfo?.outputWindow, 4_000),
        maxRetries: 0,
        abortSignal: AbortSignal.timeout(15_000),
      },
      'generate-classroom',
      undefined,
      generationFastThinkingConfig(classroomThinking),
    );
    return result.text;
  };

  // Per-stage model resolution for the scene pipeline. The classroom used to
  // bind a single `languageModel` (from the `generate-classroom` stage) into one
  // `sceneAiCall` closure shared by scene-content and scene-actions. That made
  // every `MODEL_ROUTES` entry for `scene-content` / `scene-content:<type>` /
  // `scene-actions` a no-op on this path — the browser UI already routes each
  // stage independently via /api/generate/*, but the one-shot skill API did not.
  //
  // Each stage is resolved lazily and only when a route is actually configured
  // (getStageModel returns undefined), so unrouted deployments pay zero extra
  // cost and reuse the classroom model. Resolution failure (e.g. an unknown
  // provider in the route) degrades to the classroom model with a warn, mirroring
  // the existing web-search-query-rewrite handling below — a misconfigured
  // optional route never aborts classroom generation.
  const stageModelCache = new Map<
    LlmStage,
    {
      model: LanguageModel;
      outputWindow?: number;
      thinking: ThinkingConfig | undefined;
    }
  >();

  const resolveStageModel = async (
    stage: LlmStage,
  ): Promise<{
    model: LanguageModel;
    outputWindow?: number;
    thinking: ThinkingConfig | undefined;
  }> => {
    const cached = stageModelCache.get(stage);
    if (cached) return cached;

    // No route configured → reuse the classroom model, no extra resolution.
    if (!getStageModel(stage)) {
      const fallback = {
        model: languageModel,
        outputWindow: modelInfo?.outputWindow,
        thinking: classroomThinking,
      };
      stageModelCache.set(stage, fallback);
      return fallback;
    }

    try {
      const resolved = await resolveModel({ stage });
      const entry = {
        model: resolved.model,
        outputWindow: resolved.modelInfo?.outputWindow,
        thinking: resolved.thinkingConfig,
      };
      log.info(`Stage "${stage}" routed to model: ${resolved.modelString}`);
      stageModelCache.set(stage, entry);
      return entry;
    } catch (err) {
      log.warn(
        `Stage "${stage}" route "${getStageModel(stage)}" could not be resolved; ` +
          `falling back to the generate-classroom model.`,
        err,
      );
      const fallback = {
        model: languageModel,
        outputWindow: modelInfo?.outputWindow,
        thinking: classroomThinking,
      };
      stageModelCache.set(stage, fallback);
      return fallback;
    }
  };

  // scene-content routes per outline type via the composite key
  // `scene-content:<type>` (slide/quiz/interactive/pbl), falling back to the
  // base `scene-content` route — same resolution the browser UI uses at
  // /api/generate/scene-content. Returns the aiCall plus the resolved model
  // and thinking config, because PBL scene generation drives its own LLM
  // calls through the model object (generatePBLSceneContent) rather than the
  // aiCall closure, and consumes the route's thinking config separately.
  const resolveSceneContentCall = async (
    outlineType: string | undefined,
    deadlineAt: number,
    focusedSinglePage = false,
  ) => {
    const stage = (outlineType ? `scene-content:${outlineType}` : 'scene-content') as LlmStage;
    const { model, outputWindow, thinking } = await resolveStageModel(stage);
    const buildAiCall =
      (callThinking: ThinkingConfig | undefined): AICallFn =>
      async (systemPrompt, userPrompt, _images) => {
        const effectiveSystemPrompt =
          focusedSinglePage && outlineType === 'interactive'
            ? FOCUSED_INTERACTIVE_SYSTEM_PROMPT
            : systemPrompt;
        const effectiveUserPrompt =
          focusedSinglePage && outlineType === 'interactive'
            ? `Brief:\n${requirement}\n\nWidget type: ${focusedPageType ?? 'interactive'}. Implement only the requested learning interaction and essential controls.${focusedInteractiveImplementationHint(requirement)}${focusedMobileImplementationHint(focusedPageType)}`
            : userPrompt;
        const callFocusedModel = (messages: Array<{ role: 'system' | 'user'; content: string }>) =>
          callLLM(
            {
              model,
              messages,
              // Keep each scene inside the page-level wall-clock budget. Richer
              // scene types receive a larger output allowance, but never the
              // provider's full 128k window.
              maxOutputTokens: boundedGenerationOutputTokens(
                outputWindow,
                sceneOutputTokenBudget(outlineType, focusedSinglePage),
              ),
              maxRetries: 0,
              abortSignal: AbortSignal.timeout(
                remainingBudgetMs(deadlineAt, SCENE_CONTENT_BUDGET_MS),
              ),
            },
            'generate-classroom-scene',
            undefined,
            generationFastThinkingConfig(callThinking),
          );
        let result = await callFocusedModel([
          { role: 'system', content: effectiveSystemPrompt },
          { role: 'user', content: effectiveUserPrompt },
        ]);
        if (focusedSinglePage && outlineType === 'interactive') {
          const defects = focusedInteractiveResponseDefects(result.text, result.finishReason);
          if (defects.length > 0) {
            log.warn(`Focused interactive runtime smoke check failed: ${defects.join('; ')}`);
            result = await callFocusedModel([
              { role: 'system', content: effectiveSystemPrompt },
              {
                role: 'user',
                content: `${effectiveUserPrompt}\n\nRegenerate from scratch and keep the entire document under 4,500 characters. The previous attempt failed this runtime smoke check: ${defects.join('; ')}. Verify the initial draw runs automatically, all primary buttons have working handlers, every canvas coordinate is finite, and </script></body></html> are present.`,
              },
            ]);

            const retryDefects = focusedInteractiveResponseDefects(
              result.text,
              result.finishReason,
            );
            if (retryDefects.length > 0) {
              throw new Error(
                `Focused interactive response remained incomplete after regeneration: ${retryDefects.join('; ')}`,
              );
            }
          }
        }
        if (focusedSinglePage) {
          log.info(
            `Focused ${outlineType ?? 'slide'} model response: ${result.text.length} chars, finish=${result.finishReason}`,
          );
        }
        return result.text;
      };
    const aiCall = buildAiCall(thinking);
    return { aiCall, model, thinking };
  };

  // agent-profiles routes via the `agent-profiles` stage (matches the browser
  // UI's /api/generate/agent-profiles). Lazy + cached like the scene stages.
  let agentProfilesAiCall: AICallFn | undefined;
  const getAgentProfilesAiCall = async (): Promise<AICallFn> => {
    if (agentProfilesAiCall) return agentProfilesAiCall;
    const { model, outputWindow, thinking } = await resolveStageModel('agent-profiles');
    agentProfilesAiCall = async (systemPrompt, userPrompt, _images) => {
      const result = await callLLM(
        {
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          maxOutputTokens: outputWindow,
        },
        'generate-classroom',
        undefined,
        thinking,
      );
      return result.text;
    };
    return agentProfilesAiCall;
  };

  // scene-actions routes via the `scene-actions` stage.
  const getSceneActionsAiCall = async (deadlineAt: number): Promise<AICallFn> => {
    const { model, outputWindow, thinking } = await resolveStageModel('scene-actions');
    return async (systemPrompt, userPrompt, _images) => {
      const result = await callLLM(
        {
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          maxOutputTokens: boundedGenerationOutputTokens(outputWindow, 1_200),
          maxRetries: 0,
          abortSignal: AbortSignal.timeout(remainingBudgetMs(deadlineAt, 4_000)),
        },
        'generate-classroom-scene',
        undefined,
        generationFastThinkingConfig(thinking),
      );
      return result.text;
    };
  };

  const searchQueryAiCall: AICallFn = async (systemPrompt, userPrompt, _images) => {
    const result = await callLLM(
      {
        model: searchQueryModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        maxOutputTokens: 256,
      },
      'web-search-query-rewrite',
      undefined,
      searchQueryThinking,
    );
    return result.text;
  };

  const requirements: UserRequirements = {
    requirement,
  };
  const vocationalActive = resolveVocationalActive(requirements);
  const pdfText = pdfContent?.text || undefined;

  await options.onProgress?.({
    step: 'researching',
    progress: 10,
    message: 'Researching topic',
    scenesGenerated: 0,
  });

  // Web search (optional, graceful degradation)
  let researchContext: string | undefined;
  if (input.enableWebSearch) {
    const webSearchConfig = resolveClassroomWebSearchConfig(input);
    if (webSearchConfig) {
      // Re-resolve the query-rewrite model only when explicitly routed. If
      // resolution itself fails (e.g. unknown provider in the route), fall back
      // to the classroom model here; a route with a missing key resolves fine
      // and surfaces only later in callLLM, which the outer try/catch below
      // degrades gracefully — either way the pipeline still works.
      const rewriteRoute = getStageModel('web-search-query-rewrite');
      if (rewriteRoute) {
        try {
          const rewriteResolved = await resolveModel({ stage: 'web-search-query-rewrite' });
          searchQueryModel = rewriteResolved.model;
          searchQueryThinking = rewriteResolved.thinkingConfig;
        } catch (err) {
          log.warn(
            `web-search-query-rewrite route "${rewriteRoute}" unavailable; using classroom model for query rewrite`,
            err,
          );
        }
      }
      try {
        const searchQuery = await buildSearchQuery(requirement, pdfText, searchQueryAiCall);

        log.info('Running web search for classroom generation', {
          hasPdfContext: searchQuery.hasPdfContext,
          rawRequirementLength: searchQuery.rawRequirementLength,
          rewriteAttempted: searchQuery.rewriteAttempted,
          finalQueryLength: searchQuery.finalQueryLength,
        });

        const searchResult = await searchWeb({
          providerId: webSearchConfig.providerId,
          query: searchQuery.query,
          apiKey: webSearchConfig.apiKey,
          baseUrl: webSearchConfig.baseUrl,
          baiduSubSources: webSearchConfig.baiduSubSources,
          claudeModelId: webSearchConfig.claudeModelId,
        });
        researchContext = formatSearchResultsAsContext(searchResult);
        if (researchContext) {
          log.info(`Web search returned ${searchResult.sources.length} sources`);
        }
      } catch (e) {
        log.warn('Web search failed, continuing without search context:', e);
      }
    } else {
      log.warn('enableWebSearch is true but no web search API key configured, skipping web search');
    }
  }

  await options.onProgress?.({
    step: 'generating_outlines',
    progress: 15,
    message: 'Generating scene outlines',
    scenesGenerated: 0,
  });

  let outlineData: {
    languageDirective: string;
    courseTitle?: string;
    outlines: SceneOutline[];
  };

  const focusedPageType = input.pageType ?? inferFocusedPageType(requirement);
  const focusedSinglePage = Boolean(focusedPageType) || requestsSingleSlide(requirement);

  if (focusedSinglePage) {
    outlineData = buildFastOutline(requirement, focusedPageType);
    log.info(
      `Focused one-page request detected (${focusedPageType ?? 'slide'}); bypassing the separate outline model call`,
    );
  } else {
    const outlinesResult = await withGenerationRetry(
      () =>
        generateSceneOutlinesFromRequirements(requirements, pdfText, undefined, aiCall, {
          imageGenerationEnabled: input.enableImageGeneration,
          videoGenerationEnabled: input.enableVideoGeneration,
          researchContext,
          // NO teacherContext — agents haven't been generated yet
        }),
      {
        label: 'scene outlines',
        // A malformed response must not launch another full 15-second request.
        // The deterministic outline below keeps the course generatable.
        maxRetries: 0,
        shouldRetryResult: (result) => !result.success || !result.data,
      },
    );

    if (!outlinesResult.success || !outlinesResult.data) {
      log.warn(
        `Outline generation failed; continuing with a one-page outline: ${outlinesResult.error || 'unknown error'}`,
      );
      outlineData = buildFastOutline(requirement);
    } else {
      outlineData = outlinesResult.data;
    }
  }

  const { languageDirective, courseTitle, outlines } = outlineData;
  log.info(
    `Generated ${outlines.length} scene outlines (languageDirective: ${languageDirective}, courseTitle: ${courseTitle ?? 'n/a'})`,
  );

  await options.onProgress?.({
    step: 'generating_outlines',
    progress: 30,
    message: `Generated ${outlines.length} scene outlines`,
    scenesGenerated: 0,
    totalScenes: outlines.length,
  });

  // Resolve agents based on agentMode — now AFTER outlines so we can use languageDirective
  let agents: AgentInfo[];
  const agentMode = input.agentMode || 'default';
  if (agentMode === 'generate') {
    log.info('Generating custom agent profiles via LLM...');
    try {
      const agentProfilesCall = await getAgentProfilesAiCall();
      agents = await generateAgentProfiles(requirement, languageDirective, agentProfilesCall);
      log.info(`Generated ${agents.length} agent profiles`);
    } catch (e) {
      log.warn('Agent profile generation failed, falling back to defaults:', e);
      agents = getDefaultAgents();
    }
  } else {
    agents = getDefaultAgents();
  }

  const stageId = nanoid(10);
  const stage: Stage = {
    id: stageId,
    name: courseTitle || outlines[0]?.title || requirement.slice(0, 50),
    description: undefined,
    languageDirective,
    videoManifest: buildVideoManifestFromOutlines(outlines),
    style: 'interactive',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    // For LLM-generated agents, embed full configs so the client can
    // hydrate the agent registry without prior IndexedDB data.
    // For default agents, just record IDs — the client already has them.
    ...(agentMode === 'generate'
      ? {
          generatedAgentConfigs: agents.map((a, i) => ({
            id: a.id,
            name: a.name,
            role: a.role,
            persona: a.persona || '',
            avatar: AGENT_DEFAULT_AVATARS[i % AGENT_DEFAULT_AVATARS.length],
            color: AGENT_COLOR_PALETTE[i % AGENT_COLOR_PALETTE.length],
            priority: a.role === 'teacher' ? 10 : a.role === 'assistant' ? 7 : 5,
          })),
        }
      : {
          agentIds: agents.map((a) => a.id),
        }),
  };

  const store = createInMemoryStore(stage);
  const api = createStageAPI(store);

  log.info('Stage 2: Generating scene content and actions...');
  let generatedScenes = 0;

  for (const [index, outline] of outlines.entries()) {
    const sceneStartedAt = Date.now();
    const safeOutline = applyOutlineFallbacks(outline, true, {
      allowProceduralSkill: vocationalActive,
    });
    const sceneDeadlineAt = Date.now() + SCENE_GENERATION_BUDGET_MS;
    const progressStart = 30 + Math.floor((index / Math.max(outlines.length, 1)) * 60);

    await options.onProgress?.({
      step: 'generating_scenes',
      progress: Math.max(progressStart, 31),
      message: `Generating scene ${index + 1}/${outlines.length}: ${safeOutline.title}`,
      scenesGenerated: generatedScenes,
      totalScenes: outlines.length,
    });

    try {
      const reportSceneRetry = async (
        phase: 'content' | 'actions',
        event: { attempt: number; maxAttempts: number; reason: string },
      ) => {
        const nextAttempt = Math.min(event.attempt + 1, event.maxAttempts);
        const message = `Retrying scene ${index + 1}/${outlines.length} ${phase} (${nextAttempt}/${event.maxAttempts}): ${safeOutline.title}`;
        log.warn(`${message} — ${event.reason}`);
        await options.onProgress?.({
          step: 'generating_scenes',
          progress: Math.max(progressStart, 31),
          message,
          scenesGenerated: generatedScenes,
          totalScenes: outlines.length,
        });
      };

      // Resolve this scene's content model lazily, per outline type. The package
      // gets the provider-bound AICallFn and the app injects its agentic PBL loop
      // as the classified fallback, preserving single-call → loop routing.
      const contentCall = await resolveSceneContentCall(
        safeOutline.type,
        sceneDeadlineAt,
        focusedSinglePage,
      );
      const generatedContent = await (async () => {
        try {
          return await withGenerationRetry(
            () =>
              generateSceneContent(safeOutline, contentCall.aiCall, {
                agents,
                languageDirective,
                allowProceduralSkill: vocationalActive,
                ...(safeOutline.type === 'pbl'
                  ? {
                      pblLoopFallback: (input) =>
                        generatePBLV2Project(
                          input,
                          contentCall.model,
                          callLLM,
                          { logger: log },
                          contentCall.thinking,
                        ),
                    }
                  : {}),
              }),
            {
              label: `scene ${index + 1}/${outlines.length} content`,
              // Retry only transient transport/upstream failures. In
              // particular, Vercel can occasionally hit undici's 10-second
              // TCP connect timeout before apihub accepts the connection. A
              // short, jittered retry keeps that network blip from turning a
              // completed one-page request into "No scenes were generated".
              // Empty/malformed model output is deliberately not retried: it
              // is not a transport failure and a second paid call rarely
              // repairs it. Every attempt still shares the same page deadline.
              // PBL owns a separate bounded planner fallback and must not
              // restart the whole project generation loop here.
              // Six total attempts (the first call + five retries) cover a
              // short cross-border outage without retrying indefinitely.
              maxRetries: safeOutline.type === 'pbl' ? 0 : SCENE_CONTENT_TRANSIENT_MAX_RETRIES,
              baseDelayMs: 500,
              maxDelayMs: 2_000,
              shouldRetryResult: () => false,
              onRetry: (event) => reportSceneRetry('content', event),
            },
          );
        } catch (error) {
          if (error instanceof PBLGenerationError) {
            return containPBLGenerationError(error, safeOutline.title);
          }
          log.warn(
            `Scene "${safeOutline.title}" content generation failed inside the page budget; using fallback: ${error instanceof Error ? error.message : String(error)}`,
          );
          return null;
        }
      })();

      let completedOutline = safeOutline;
      let content: GeneratedSceneContent;
      let actions: Action[] = [];

      if (!generatedContent && focusedSinglePage && focusedPageType) {
        throw new Error(
          `Focused ${focusedPageType} page generation returned no usable content; refusing to publish a non-interactive fallback.`,
        );
      } else if (!generatedContent) {
        const fallback = buildTimedOutSceneFallback(safeOutline);
        completedOutline = fallback.outline;
        content = fallback.content;
        actions = fallback.actions;
        log.warn(
          `Scene "${safeOutline.title}" content exceeded its fast budget; publishing fallback slide`,
        );
      } else {
        content = generatedContent;
        const remainingMs = sceneDeadlineAt - Date.now();
        // Focused pages are fully self-contained. Teacher narration/actions
        // would add a second model call without improving the page itself.
        if (!focusedSinglePage && remainingMs >= MIN_ACTION_BUDGET_MS) {
          try {
            const actionsAiCall = await getSceneActionsAiCall(sceneDeadlineAt);
            actions = await withGenerationRetry(
              () =>
                generateSceneActions(safeOutline, content, actionsAiCall, {
                  agents,
                  languageDirective,
                }),
              {
                label: `scene ${index + 1}/${outlines.length} actions`,
                maxRetries: 0,
                onRetry: (event) => reportSceneRetry('actions', event),
              },
            );
          } catch (actionError) {
            log.warn(
              `Scene "${safeOutline.title}" actions missed the page budget; publishing without narration`,
              actionError,
            );
          }
        } else {
          log.warn(
            `Scene "${safeOutline.title}" used its page budget on content; publishing without narration`,
          );
        }
      }
      log.info(
        `Scene "${safeOutline.title}": ${actions.length} actions in ${Date.now() - sceneStartedAt}ms`,
      );
      if (focusedSinglePage && Date.now() - sceneStartedAt > SCENE_GENERATION_TARGET_MS) {
        log.warn(
          `Focused page exceeded the ${SCENE_GENERATION_TARGET_MS}ms performance target without being aborted`,
        );
      }

      const sceneId = createSceneWithActions(completedOutline, content, actions, api);
      if (!sceneId) {
        log.warn(`Skipping scene "${safeOutline.title}" — scene creation failed`);
        continue;
      }

      generatedScenes += 1;
      const progressEnd = 30 + Math.floor(((index + 1) / Math.max(outlines.length, 1)) * 60);
      await options.onProgress?.({
        step: 'generating_scenes',
        progress: Math.min(progressEnd, 90),
        message: `Generated ${generatedScenes}/${outlines.length} scenes`,
        scenesGenerated: generatedScenes,
        totalScenes: outlines.length,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn(
        `Skipping scene ${index + 1}/${outlines.length} "${safeOutline.title}" after isolated failure: ${message}`,
      );
      await options.onProgress?.({
        step: 'generating_scenes',
        progress: Math.min(30 + Math.floor(((index + 1) / Math.max(outlines.length, 1)) * 60), 90),
        message: `Skipped failed scene ${index + 1}/${outlines.length}; continuing`,
        scenesGenerated: generatedScenes,
        totalScenes: outlines.length,
      });
    }
  }

  const scenes = store.getState().scenes;
  log.info(`Pipeline complete: ${scenes.length} scenes generated`);

  if (scenes.length === 0) {
    throw new Error('No scenes were generated');
  }

  // Enhancement phase: media and narration consume independent providers and
  // independent scene fields, so run them concurrently. Serializing image /
  // video work before TTS made a course pay the sum of every provider latency;
  // collaboration should cost approximately the slowest enabled enhancement.
  const enhancementTasks: Promise<void>[] = [];

  if (input.enableImageGeneration || input.enableVideoGeneration) {
    enhancementTasks.push(
      (async () => {
        await options.onProgress?.({
          step: 'generating_media',
          progress: 90,
          message: 'Generating media files in parallel with narration',
          scenesGenerated: scenes.length,
          totalScenes: outlines.length,
        });

        try {
          const mediaMap = await generateMediaForClassroom(outlines, stageId, options.baseUrl);
          replaceMediaPlaceholders(scenes, mediaMap);
          log.info(`Media generation complete: ${Object.keys(mediaMap).length} files`);
        } catch (err) {
          log.warn('Media generation phase failed, continuing:', err);
        }
      })(),
    );
  }

  if (input.enableTTS) {
    enhancementTasks.push(
      (async () => {
        await options.onProgress?.({
          step: 'generating_tts',
          progress: 94,
          message: 'Generating narration in parallel with media',
          scenesGenerated: scenes.length,
          totalScenes: outlines.length,
        });

        try {
          await generateTTSForClassroom(scenes, stageId, options.baseUrl);
          log.info('TTS generation complete');
        } catch (err) {
          log.warn('TTS generation phase failed, continuing:', err);
        }
      })(),
    );
  }

  await Promise.all(enhancementTasks);

  await options.onProgress?.({
    step: 'persisting',
    progress: 98,
    message: 'Persisting classroom data',
    scenesGenerated: scenes.length,
    totalScenes: outlines.length,
  });

  const persisted = await persistClassroom(
    {
      id: stageId,
      stage,
      scenes,
    },
    options.baseUrl,
  );

  log.info(`Classroom persisted: ${persisted.id}, URL: ${persisted.url}`);

  await options.onProgress?.({
    step: 'completed',
    progress: 100,
    message: 'Classroom generation completed',
    scenesGenerated: scenes.length,
    totalScenes: outlines.length,
  });

  return {
    id: persisted.id,
    url: persisted.url,
    stage,
    scenes,
    scenesCount: scenes.length,
    createdAt: persisted.createdAt,
  };
}
