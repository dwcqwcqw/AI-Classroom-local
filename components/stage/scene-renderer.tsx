'use client';

import dynamic from 'next/dynamic';
import { useMemo } from 'react';
import type { Scene, StageMode } from '@/lib/types/stage';

const SlideRenderer = dynamic(
  () => import('../slide-renderer/Editor').then((module) => module.SlideEditor),
  { ssr: false },
);
const QuizView = dynamic(
  () => import('../scene-renderers/quiz-view').then((module) => module.QuizView),
  { ssr: false },
);
const InteractiveRenderer = dynamic(
  () =>
    import('../scene-renderers/interactive-renderer').then((module) => module.InteractiveRenderer),
  { ssr: false },
);
const PBLRenderer = dynamic(
  () => import('../scene-renderers/pbl-renderer').then((module) => module.PBLRenderer),
  { ssr: false },
);

interface SceneRendererProps {
  readonly scene: Scene;
  readonly mode: StageMode;
}

/**
 * Playback scene dispatcher. In Pro (edit) mode, Stage renders EditShell
 * directly as a top-level takeover — SceneRenderer is only on the playback
 * path, so it does not branch on `mode === 'edit'`.
 */
export function SceneRenderer({ scene, mode }: SceneRendererProps) {
  const renderer = useMemo(() => {
    switch (scene.type) {
      case 'slide':
        if (scene.content.type !== 'slide') return <div>Invalid slide content</div>;
        return <SlideRenderer mode={mode} />;
      case 'quiz':
        if (scene.content.type !== 'quiz') return <div>Invalid quiz content</div>;
        return (
          <QuizView
            key={scene.id}
            questions={scene.content.questions}
            sceneId={scene.id}
            stageId={scene.stageId}
          />
        );
      case 'interactive':
        if (scene.content.type !== 'interactive') return <div>Invalid interactive content</div>;
        return <InteractiveRenderer content={scene.content} sceneId={scene.id} />;
      case 'pbl':
        if (scene.content.type !== 'pbl') return <div>Invalid PBL content</div>;
        return <PBLRenderer content={scene.content} mode={mode} sceneId={scene.id} />;
      default:
        return <div>Unknown scene type</div>;
    }
  }, [scene, mode]);

  return <div className="w-full h-full">{renderer}</div>;
}
