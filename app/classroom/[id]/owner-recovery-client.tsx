'use client';

import { Stage } from '@/components/stage';
import { ThemeProvider } from '@/lib/hooks/use-theme';
import { useStageStore } from '@/lib/store';
import { useSettingsStore } from '@/lib/store/settings';
import { claimStageSceneLoadToken, isCurrentStageSceneLoadToken } from '@/lib/store/stage';
import { useEffect, useRef, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { useSceneGenerator } from '@/lib/hooks/use-scene-generator';
import { useMediaGenerationStore } from '@/lib/store/media-generation';
import { useWhiteboardHistoryStore } from '@/lib/store/whiteboard-history';
import { createLogger } from '@/lib/logger';
import { MediaStageProvider } from '@/lib/contexts/media-stage-context';
import { generateMediaForOutlines } from '@/lib/media/media-orchestrator';
import { loadImageMapping } from '@/lib/utils/image-storage';
import { useAgentRegistry } from '@/lib/orchestration/registry/store';
import {
  applyClassroomStageAndScenes,
  defaultClassroomLoadDeps,
  runClassroomLoad,
} from '@/lib/classroom/load-classroom';
import { applyHydratedClassroomFallbackScenes } from '@/lib/classroom/pbl-fallback-hydration';

const log = createLogger('Classroom');

export default function ClassroomDetailPage() {
  const params = useParams();
  const classroomId = params?.id as string;
  const { loadFromStorage: loadLocalClassroom } = useStageStore();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const generationStartedRef = useRef(false);
  const hasPrivateOwnerCopyRef = useRef(false);
  const canonicalPublishQueueRef = useRef<Promise<void>>(Promise.resolve());

  const persistCanonicalSnapshot = useCallback(async () => {
    canonicalPublishQueueRef.current = canonicalPublishQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        const state = useStageStore.getState();
        if (!state.stage) return;
        try {
          const response = await fetch('/api/classroom', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ stage: state.stage, scenes: state.scenes }),
          });
          if (!response.ok) {
            log.warn(`Failed to publish classroom progress: HTTP ${response.status}`);
          }
        } catch (publishError) {
          log.warn('Failed to publish classroom progress:', publishError);
        }
      });
    await canonicalPublishQueueRef.current;
  }, []);

  const { generateRemaining, stop } = useSceneGenerator({
    onSceneGenerated: () => {
      // Publish after every successful page. A later page failure or a Vercel
      // function restart can no longer discard the pages already completed.
      void persistCanonicalSnapshot();
    },
    onComplete: () => {
      void persistCanonicalSnapshot();
    },
  });

  const loadClassroom = useCallback(
    async (isEffectCurrent: () => boolean = () => true) => {
      const loadToken = claimStageSceneLoadToken();
      const isCurrent = () => isEffectCurrent() && isCurrentStageSceneLoadToken(loadToken);
      let canonicalCourseFetched = false;

      const applyCanonicalCourse = async (
        stage: Parameters<typeof applyClassroomStageAndScenes>[0],
        scenes: Parameters<typeof applyClassroomStageAndScenes>[1],
      ) =>
        applyHydratedClassroomFallbackScenes({
          loadToken,
          isCurrent,
          stage,
          scenes,
          // Public playback has no browser-private chat history to restore.
          // Waiting for IndexedDB/session persistence here delayed an already
          // fetched canonical course by 10-20 seconds.
          hydrateChats: async () => ({
            chats: [],
            chatSnapshot: { sessions: [], restoreMarker: null },
          }),
          applyStageAndScenes: (nextStage, nextScenes, options) =>
            applyClassroomStageAndScenes(nextStage, nextScenes, { ...options, persist: false }),
        });

      await runClassroomLoad({
        classroomId,
        loadToken,
        isCurrent,
        // Public shares prefer the canonical server document. MCP-generated
        // classrooms never have a browser-local IndexedDB copy, and waiting
        // for private persistence first can leave an otherwise healthy public
        // course stuck on the loading screen.
        loadFromStorage: async (id, token) => {
          const canonical = await defaultClassroomLoadDeps.fetchClassroom(id, () => false);
          if (!isCurrent()) return;
          if (canonical) {
            canonicalCourseFetched = true;
            await applyCanonicalCourse(canonical.stage, canonical.scenes);
            return;
          }

          // Courses created before durable server persistence may only exist in
          // the owner's IndexedDB. Recover that one legacy copy through the
          // authenticated write route only when no canonical server copy exists.
          try {
            await loadLocalClassroom(id, token);
          } catch (localError) {
            // Anonymous viewers have no private persistence session. That is
            // expected: skip the legacy-owner recovery path and continue to
            // the public canonical classroom API below.
            log.info('No accessible local classroom copy; using public server copy:', localError);
            return;
          }
          if (!isCurrent()) return;

          const local = useStageStore.getState();
          if (local.stage?.id !== id || local.scenes.length === 0) return;
          hasPrivateOwnerCopyRef.current = true;

          try {
            const response = await fetch('/api/classroom', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ stage: local.stage, scenes: local.scenes }),
            });
            if (!response.ok || !isCurrent()) return;

            const migratedCanonical = await defaultClassroomLoadDeps.fetchClassroom(
              id,
              () => false,
            );
            if (!migratedCanonical || !isCurrent()) return;
            canonicalCourseFetched = true;
            await applyCanonicalCourse(migratedCanonical.stage, migratedCanonical.scenes);
          } catch (migrationError) {
            log.warn('Legacy classroom server migration failed:', migrationError);
          }
        },
        getCurrentStage: () => (canonicalCourseFetched ? useStageStore.getState().stage : null),
        fetchClassroom: async (id) => {
          // Do not pre-download every narration before showing the first frame.
          // The playback engine keeps these transport URLs and requests one
          // durable audio clip at a time after the viewer's first tap.
          const classroom = await defaultClassroomLoadDeps.fetchClassroom(id, () => false);
          canonicalCourseFetched = Boolean(classroom);
          return classroom;
        },
        applyFallbackScenes: (args) => applyCanonicalCourse(args.stage, args.scenes),
        loadRestoredMediaTasks: (id) =>
          canonicalCourseFetched
            ? Promise.resolve({})
            : defaultClassroomLoadDeps.loadRestoredMediaTasks(id),
        applyRestoredMediaTasks: defaultClassroomLoadDeps.applyRestoredMediaTasks,
        discardRestoredMediaTasks: defaultClassroomLoadDeps.discardRestoredMediaTasks,
        loadLegacyAgentFallbacks: (id) =>
          canonicalCourseFetched
            ? Promise.resolve([])
            : defaultClassroomLoadDeps.loadLegacyAgentFallbacks(id),
        commitMigratedAgentConfigs: defaultClassroomLoadDeps.commitMigratedAgentConfigs,
        applyGeneratedAgents: defaultClassroomLoadDeps.applyGeneratedAgents,
        getSettings: () => useSettingsStore.getState(),
        getAgent: (id) => useAgentRegistry.getState().getAgent(id),
        restoreAgentSelection: defaultClassroomLoadDeps.restoreAgentSelection,
        setError,
        setLoading,
        log,
      });
    },
    [classroomId, loadLocalClassroom],
  );

  useEffect(() => {
    // Reset loading state on course switch to unmount Stage during transition,
    // preventing stale data from syncing back to the new course
    /* eslint-disable react-hooks/set-state-in-effect -- Course switch must hide stale Stage before async load */
    setLoading(true);
    setError(null);
    /* eslint-enable react-hooks/set-state-in-effect */
    generationStartedRef.current = false;
    hasPrivateOwnerCopyRef.current = false;
    // Clear previous classroom's media tasks to prevent cross-classroom contamination.
    // Placeholder IDs (gen_img_1, gen_vid_1) are NOT globally unique across stages,
    // so stale tasks from a previous classroom would shadow the new one's.
    const mediaStore = useMediaGenerationStore.getState();
    mediaStore.revokeObjectUrls();
    useMediaGenerationStore.setState({ tasks: {} });

    // Clear whiteboard history to prevent snapshots from a previous course leaking in.
    useWhiteboardHistoryStore.getState().clearHistory();

    let cancelled = false;
    loadClassroom(() => !cancelled);

    return () => {
      cancelled = true;
      stop();
    };
  }, [classroomId, loadClassroom, stop]);

  // Only the authenticated owner's durable private document carries outlines
  // and generation parameters. Anonymous viewers stay read-only while the
  // owner can safely resume an interrupted course from the first missing page.
  useEffect(() => {
    if (loading || error || generationStartedRef.current || !hasPrivateOwnerCopyRef.current) {
      return;
    }

    const state = useStageStore.getState();
    const { outlines, scenes, stage, generationComplete } = state;
    if (!stage || outlines.length === 0) return;

    const completedOrders = new Set(scenes.map((scene) => scene.order));
    const hasPending = !generationComplete && outlines.some((o) => !completedOrders.has(o.order));

    generationStartedRef.current = true;
    if (!hasPending) {
      state.markGenerationCompleteIfDone();
      const materializedOutlines = outlines.filter((o) => completedOrders.has(o.order));
      void generateMediaForOutlines(materializedOutlines, stage.id).catch((mediaError) => {
        log.warn('[Classroom] Media generation resume error:', mediaError);
      });
      return;
    }

    let params: Record<string, unknown> = {};
    try {
      const stored = sessionStorage.getItem('generationParams');
      params = stored ? (JSON.parse(stored) as Record<string, unknown>) : {};
    } catch (paramsError) {
      log.warn('Could not restore generation parameters; using course defaults:', paramsError);
    }

    const pdfImages = (params.pdfImages || []) as Array<{
      id: string;
      assetId?: string;
      storageId?: string;
    }>;
    const imageMapping: Record<string, string> = {};
    for (const image of pdfImages) {
      if (image.assetId) imageMapping[image.id] = image.assetId;
    }
    const storageIds = pdfImages
      .filter((image) => !image.assetId && image.storageId)
      .map((image) => image.storageId as string);

    void (async () => {
      if (storageIds.length > 0) {
        Object.assign(imageMapping, await loadImageMapping(storageIds));
      }
      await generateRemaining({
        pdfImages: params.pdfImages as Parameters<typeof generateRemaining>[0]['pdfImages'],
        imageMapping,
        stageInfo: {
          name: stage.name || '',
          description: stage.description,
          style: stage.style,
        },
        agents: params.agents as Parameters<typeof generateRemaining>[0]['agents'],
        userProfile: params.userProfile as string | undefined,
        languageDirective:
          (params.languageDirective as string | undefined) || stage.languageDirective,
      });
      await persistCanonicalSnapshot();
    })().catch((generationError) => {
      log.warn('Interrupted classroom generation could not resume:', generationError);
    });
  }, [error, generateRemaining, loading, persistCanonicalSnapshot]);

  return (
    <ThemeProvider>
      <MediaStageProvider value={classroomId}>
        <div className="h-[100dvh] w-screen overflow-hidden bg-black">
          {loading ? (
            <div className="grid h-full place-items-center bg-black">
              <div className="text-center text-sm text-white/65" role="status">
                <p>正在加载课程…</p>
              </div>
            </div>
          ) : error ? (
            <div className="grid h-full place-items-center bg-black px-6">
              <div className="text-center">
                <p className="mb-4 text-sm text-white/70">课程暂时无法加载</p>
                <button
                  onClick={() => {
                    setError(null);
                    setLoading(true);
                    loadClassroom();
                  }}
                  className="min-h-11 rounded-full bg-white px-5 py-2 text-sm font-medium text-black"
                >
                  重新加载
                </button>
              </div>
            </div>
          ) : (
            <Stage publicViewer />
          )}
        </div>
      </MediaStageProvider>
    </ThemeProvider>
  );
}
