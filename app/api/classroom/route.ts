import { type NextRequest } from 'next/server';
import { randomUUID } from 'crypto';
import { apiSuccess, apiError, API_ERROR_CODES } from '@/lib/server/api-response';
import {
  buildRequestOrigin,
  isValidClassroomId,
  persistClassroom,
  readClassroom,
} from '@/lib/server/classroom-storage';
import { createLogger } from '@/lib/logger';

const log = createLogger('Classroom API');

export async function POST(request: NextRequest) {
  let stageId: string | undefined;
  let sceneCount: number | undefined;
  try {
    const body = await request.json();
    const { stage, scenes } = body;
    stageId = stage?.id;
    sceneCount = scenes?.length;

    if (!stage || !scenes) {
      return apiError(
        API_ERROR_CODES.MISSING_REQUIRED_FIELD,
        400,
        'Missing required fields: stage, scenes',
      );
    }

    const id = stage.id || randomUUID();
    const baseUrl = buildRequestOrigin(request);

    const persisted = await persistClassroom({ id, stage: { ...stage, id }, scenes }, baseUrl);

    return apiSuccess({ id: persisted.id, url: persisted.url }, 201);
  } catch (error) {
    log.error(
      `Classroom storage failed [stageId=${stageId ?? 'unknown'}, scenes=${sceneCount ?? 0}]:`,
      error,
    );
    return apiError(
      API_ERROR_CODES.INTERNAL_ERROR,
      500,
      'Failed to store classroom',
      error instanceof Error ? error.message : String(error),
    );
  }
}

export async function GET(request: NextRequest) {
  try {
    const id = request.nextUrl.searchParams.get('id');

    if (!id) {
      return apiError(
        API_ERROR_CODES.MISSING_REQUIRED_FIELD,
        400,
        'Missing required parameter: id',
      );
    }

    if (!isValidClassroomId(id)) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, 'Invalid classroom id');
    }

    const classroom = await readClassroom(id);
    if (!classroom) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 404, 'Classroom not found');
    }

    // Public classroom viewers receive a durable, course-scoped audio URL for
    // every speech action. Existing generated audio is reused; older courses
    // lazily materialize the missing audio on first playback.
    const classroomForViewer = structuredClone(classroom);
    for (const scene of classroomForViewer.scenes) {
      for (const action of scene.actions ?? []) {
        if (action.type !== 'speech' || !action.text) continue;
        const transportAction = action as typeof action & { audioUrl?: string };
        if (!transportAction.audioUrl) {
          transportAction.audioId = `tts_s${scene.order}_${action.id}`;
          transportAction.audioUrl = `/api/classroom-audio/${encodeURIComponent(id)}/${encodeURIComponent(scene.id)}/${encodeURIComponent(action.id)}`;
        }
      }
    }

    const response = apiSuccess({ classroom: classroomForViewer });
    // Public share manifests are identical for every viewer. Keep browsers on
    // revalidation while allowing Vercel's regional CDN to absorb repeated
    // cross-border reads. The short freshness window still exposes generation
    // progress quickly when a creator publishes another page.
    response.headers.set('Cache-Control', 'public, max-age=0, must-revalidate');
    response.headers.set(
      'Vercel-CDN-Cache-Control',
      'public, s-maxage=10, stale-while-revalidate=60',
    );
    return response;
  } catch (error) {
    log.error(
      `Classroom retrieval failed [id=${request.nextUrl.searchParams.get('id') ?? 'unknown'}]:`,
      error,
    );
    return apiError(
      API_ERROR_CODES.INTERNAL_ERROR,
      500,
      'Failed to retrieve classroom',
      error instanceof Error ? error.message : String(error),
    );
  }
}
