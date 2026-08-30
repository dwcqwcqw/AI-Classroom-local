import { NextRequest, NextResponse } from 'next/server';

import { generateTTSForClassroom } from '@/lib/server/classroom-media-generation';
import { assetBody, readClassroomAsset } from '@/lib/server/classroom-assets';
import {
  buildRequestOrigin,
  isValidClassroomId,
  readClassroom,
} from '@/lib/server/classroom-storage';
import type { SpeechAction } from '@/lib/types/action';

const activeGenerations = new Map<string, Promise<void>>();

function safeSegment(value: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(value);
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ classroomId: string; sceneId: string; actionId: string }> },
) {
  const { classroomId, sceneId, actionId } = await params;
  if (!isValidClassroomId(classroomId) || !safeSegment(sceneId) || !safeSegment(actionId)) {
    return NextResponse.json({ error: 'Invalid audio reference' }, { status: 400 });
  }

  const classroom = await readClassroom(classroomId);
  const scene = classroom?.scenes.find((candidate) => candidate.id === sceneId);
  const action = scene?.actions?.find(
    (candidate): candidate is SpeechAction =>
      candidate.id === actionId && candidate.type === 'speech',
  );
  if (!classroom || !scene || !action?.text) {
    return NextResponse.json({ error: 'Audio not found' }, { status: 404 });
  }

  const audioId = `tts_s${scene.order}_${action.id}`;
  const assetPath = `audio/${audioId}.mp3`;
  let asset = await readClassroomAsset(classroomId, assetPath);

  if (!asset) {
    const generationKey = `${classroomId}:${sceneId}:${actionId}`;
    let generation = activeGenerations.get(generationKey);
    if (!generation) {
      generation = generateTTSForClassroom(
        [{ ...scene, actions: [{ ...action }] }],
        classroomId,
        buildRequestOrigin(request),
      ).finally(() => activeGenerations.delete(generationKey));
      activeGenerations.set(generationKey, generation);
    }
    await generation;
    asset = await readClassroomAsset(classroomId, assetPath);
  }

  if (!asset) {
    return NextResponse.json({ error: 'Audio generation is unavailable' }, { status: 503 });
  }

  return new NextResponse(assetBody(asset), {
    headers: {
      'Content-Type': asset.contentType,
      'Content-Length': String(asset.bytes.length),
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
}
