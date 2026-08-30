'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useRef, useState } from 'react';
import { MediaStageProvider } from '@/lib/contexts/media-stage-context';
import type { Scene, Stage } from '@/lib/types/stage';

interface ClassroomPayload {
  stage: Stage;
  scenes: Scene[];
}

const InteractiveScene = dynamic(
  () =>
    Promise.all([
      import('@/components/scene-renderers/interactive-renderer'),
      import('@/components/scene-renderers/InteractiveIframeHost'),
    ]).then(([renderer, host]) => {
      function PublicInteractiveScene({ scene }: { readonly scene: Scene }) {
        if (scene.content.type !== 'interactive') return null;
        return (
          <>
            <InteractiveIframeHostBridge Host={host.InteractiveIframeHost} />
            <renderer.InteractiveRenderer content={scene.content} sceneId={scene.id} />
          </>
        );
      }
      return PublicInteractiveScene;
    }),
  { ssr: false },
);

function InteractiveIframeHostBridge({ Host }: { readonly Host: React.ComponentType }) {
  return <Host />;
}

const QuizScene = dynamic(
  () =>
    import('@/components/scene-renderers/quiz-view').then((module) => {
      function PublicQuizScene({ scene }: { readonly scene: Scene }) {
        if (scene.content.type !== 'quiz') return null;
        return (
          <module.QuizView
            questions={scene.content.questions}
            sceneId={scene.id}
            stageId={scene.stageId}
          />
        );
      }
      return PublicQuizScene;
    }),
  { ssr: false },
);

const PBLScene = dynamic(
  () =>
    import('@/components/scene-renderers/pbl-renderer').then((module) => {
      function PublicPBLScene({ scene }: { readonly scene: Scene }) {
        if (scene.content.type !== 'pbl') return null;
        return <module.PBLRenderer content={scene.content} mode="playback" sceneId={scene.id} />;
      }
      return PublicPBLScene;
    }),
  { ssr: false },
);

// Slide playback still needs the action/audio engine. Keep that larger legacy
// path out of interactive, quiz and PBL classrooms and download it only when a
// slide is actually encountered.
const SlidePlayback = dynamic(() => import('./public-slide-playback'), {
  ssr: false,
  loading: () => <LoadingScreen />,
});

const OwnerRecovery = dynamic(() => import('./owner-recovery-client'), {
  ssr: false,
  loading: () => <LoadingScreen />,
});

function LoadingScreen() {
  return (
    <div className="grid h-full w-full place-items-center bg-black" role="status">
      <p className="text-sm text-white/65">正在加载课程…</p>
    </div>
  );
}

function ErrorScreen({ retry }: { readonly retry: () => void }) {
  return (
    <div className="grid h-full w-full place-items-center bg-black px-6">
      <div className="text-center">
        <p className="mb-4 text-sm text-white/70">课程暂时无法加载</p>
        <button
          type="button"
          onClick={retry}
          className="min-h-11 rounded-full bg-white px-5 py-2 text-sm font-medium text-black"
        >
          重新加载
        </button>
      </div>
    </div>
  );
}

export function PublicClassroomClient({ classroomId }: { readonly classroomId: string }) {
  const [classroom, setClassroom] = useState<ClassroomPayload | null>(null);
  const [sceneIndex, setSceneIndex] = useState(0);
  const [status, setStatus] = useState<'loading' | 'ready' | 'missing' | 'error'>('loading');
  const requestRef = useRef(0);
  const touchStartXRef = useRef<number | null>(null);

  const load = useCallback(async () => {
    const requestId = ++requestRef.current;
    setStatus('loading');
    try {
      const response = await fetch(`/api/classroom?id=${encodeURIComponent(classroomId)}`);
      if (requestId !== requestRef.current) return;
      if (response.status === 404) {
        setStatus('missing');
        return;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = (await response.json()) as {
        success?: boolean;
        classroom?: ClassroomPayload;
      };
      if (!payload.success || !payload.classroom || payload.classroom.scenes.length === 0) {
        throw new Error('Invalid classroom payload');
      }
      setClassroom(payload.classroom);
      setSceneIndex(0);
      setStatus('ready');
    } catch {
      if (requestId === requestRef.current) setStatus('error');
    }
  }, [classroomId]);

  useEffect(() => {
    void load();
    return () => {
      requestRef.current += 1;
    };
  }, [load]);

  const moveScene = useCallback(
    (direction: -1 | 1) => {
      if (!classroom) return;
      setSceneIndex((current) =>
        Math.max(0, Math.min(classroom.scenes.length - 1, current + direction)),
      );
    },
    [classroom],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft') moveScene(-1);
      if (event.key === 'ArrowRight') moveScene(1);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [moveScene]);

  if (status === 'missing') return <OwnerRecovery />;
  if (status === 'loading') return <LoadingScreen />;
  if (status === 'error' || !classroom) return <ErrorScreen retry={() => void load()} />;

  const scene = classroom.scenes[sceneIndex];
  if (scene.type === 'slide') {
    return <SlidePlayback classroom={classroom} initialSceneId={scene.id} />;
  }

  return (
    <MediaStageProvider value={classroomId}>
      <main
        className="relative h-[100dvh] w-screen touch-pan-y overflow-hidden bg-black"
        onTouchStart={(event) => {
          touchStartXRef.current = event.changedTouches[0]?.clientX ?? null;
        }}
        onTouchEnd={(event) => {
          const startX = touchStartXRef.current;
          touchStartXRef.current = null;
          const endX = event.changedTouches[0]?.clientX;
          if (startX === null || endX === undefined || Math.abs(endX - startX) < 48) return;
          moveScene(endX < startX ? 1 : -1);
        }}
      >
        <div className="absolute inset-0 overflow-hidden bg-white">
          {scene.type === 'interactive' && <InteractiveScene scene={scene} />}
          {scene.type === 'quiz' && <QuizScene scene={scene} />}
          {scene.type === 'pbl' && <PBLScene scene={scene} />}
        </div>
      </main>
    </MediaStageProvider>
  );
}
