import { NextRequest, NextResponse } from 'next/server';
import { isValidClassroomId } from '@/lib/server/classroom-storage';
import { createLogger } from '@/lib/logger';
import { assetBody, readClassroomAsset } from '@/lib/server/classroom-assets';

const log = createLogger('ClassroomMedia');

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ classroomId: string; path: string[] }> },
) {
  const { classroomId, path: pathSegments } = await params;

  // Validate classroomId
  if (!isValidClassroomId(classroomId)) {
    return NextResponse.json({ error: 'Invalid classroom ID' }, { status: 400 });
  }

  // Validate path segments — no traversal
  const joined = pathSegments.join('/');
  if (joined.includes('..') || pathSegments.some((s) => s.includes('\0'))) {
    return NextResponse.json({ error: 'Invalid path' }, { status: 400 });
  }

  // Only allow media/ and audio/ subdirectories
  const subDir = pathSegments[0];
  if (subDir !== 'media' && subDir !== 'audio') {
    return NextResponse.json({ error: 'Invalid path' }, { status: 404 });
  }

  try {
    const asset = await readClassroomAsset(classroomId, joined);
    if (!asset) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    return new NextResponse(assetBody(asset), {
      status: 200,
      headers: {
        'Content-Type': asset.contentType,
        'Content-Length': String(asset.bytes.length),
        'Cache-Control': 'public, max-age=86400, immutable',
      },
    });
  } catch (error) {
    log.error(
      `Classroom media serving failed [classroomId=${classroomId}, path=${joined}]:`,
      error,
    );
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
