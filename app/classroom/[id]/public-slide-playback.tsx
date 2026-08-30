'use client';

import { useEffect } from 'react';
import { Stage } from '@/components/stage';
import { ThemeProvider } from '@/lib/hooks/use-theme';
import { MediaStageProvider } from '@/lib/contexts/media-stage-context';
import { useStageStore } from '@/lib/store';
import type { Scene, Stage as StageDocument } from '@/lib/types/stage';

interface ClassroomPayload {
  stage: StageDocument;
  scenes: Scene[];
}

export default function PublicSlidePlayback({
  classroom,
  initialSceneId,
}: {
  readonly classroom: ClassroomPayload;
  readonly initialSceneId: string;
}) {
  useEffect(() => {
    useStageStore.setState((state) => ({
      stage: classroom.stage,
      scenes: classroom.scenes,
      currentSceneId: initialSceneId,
      chats: [],
      chatSnapshot: { sessions: [], restoreMarker: null },
      generationComplete: true,
      generationEpoch: state.generationEpoch + 1,
      mode: 'playback',
    }));
  }, [classroom, initialSceneId]);

  return (
    <ThemeProvider>
      <MediaStageProvider value={classroom.stage.id}>
        <div className="h-[100dvh] w-screen overflow-hidden bg-black">
          <Stage publicViewer />
        </div>
      </MediaStageProvider>
    </ThemeProvider>
  );
}
