import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/server/classroom-storage', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/server/classroom-storage')>();
  return {
    ...original,
    isValidClassroomId: vi.fn(() => true),
    readClassroom: vi.fn(async () => ({
      stage: { id: 'stage-1', name: '测试课堂' },
      scenes: [
        {
          id: 'scene-1',
          stageId: 'stage-1',
          type: 'quiz',
          content: { type: 'quiz', questions: [] },
        },
      ],
    })),
  };
});

describe('public classroom fallback redirect', () => {
  const previousPublicSiteUrl = process.env.PUBLIC_SITE_URL;

  afterEach(() => {
    if (previousPublicSiteUrl === undefined) delete process.env.PUBLIC_SITE_URL;
    else process.env.PUBLIC_SITE_URL = previousPublicSiteUrl;
  });

  it('uses the canonical public origin instead of the container listener', async () => {
    process.env.PUBLIC_SITE_URL = 'https://www.onlineteacher.bookln.cn';
    const { GET } = await import('@/app/public-classroom/[id]/route');
    const response = await GET(
      new NextRequest('http://0.0.0.0:3000/public-classroom/S-PEq4fRj1'),
      { params: Promise.resolve({ id: 'S-PEq4fRj1' }) },
    );

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'https://www.onlineteacher.bookln.cn/classroom/S-PEq4fRj1?full=1',
    );
  });
});
