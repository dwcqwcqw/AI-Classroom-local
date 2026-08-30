import { promises as fs } from 'fs';
import path from 'path';

import { CLASSROOMS_DIR, isValidClassroomId } from '@/lib/server/classroom-storage';
import { getServerDatabasePool } from '@/lib/server/postgres';

export interface ClassroomAsset {
  bytes: Buffer;
  contentType: string;
}

let assetTableReady: Promise<void> | undefined;

async function ensureAssetTable(): Promise<void> {
  const pool = getServerDatabasePool();
  if (!pool) return;
  assetTableReady ??= pool
    .query(
      `
      CREATE TABLE IF NOT EXISTS openmaic_classroom_assets (
        classroom_id text NOT NULL,
        asset_path text NOT NULL,
        bytes bytea NOT NULL,
        content_type text NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (classroom_id, asset_path)
      )
    `,
    )
    .then(() => undefined);
  return assetTableReady;
}

function validateAssetLocation(classroomId: string, assetPath: string): void {
  if (!isValidClassroomId(classroomId)) throw new Error('Invalid classroom id');
  const segments = assetPath.split('/');
  if (
    segments.length < 2 ||
    !['audio', 'media'].includes(segments[0]) ||
    segments.some((segment) => !segment || segment === '..' || segment.includes('\0'))
  ) {
    throw new Error('Invalid classroom asset path');
  }
}

/** Persist generated media durably in Supabase Postgres on hosted deployments. */
export async function persistClassroomAsset(
  classroomId: string,
  assetPath: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<void> {
  validateAssetLocation(classroomId, assetPath);
  const buffer = Buffer.from(bytes);
  const pool = getServerDatabasePool();
  if (pool) {
    await ensureAssetTable();
    await pool.query(
      `INSERT INTO openmaic_classroom_assets (classroom_id, asset_path, bytes, content_type)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (classroom_id, asset_path) DO UPDATE
       SET bytes = EXCLUDED.bytes, content_type = EXCLUDED.content_type, updated_at = now()`,
      [classroomId, assetPath, buffer, contentType],
    );
    return;
  }

  const filePath = path.join(CLASSROOMS_DIR, classroomId, assetPath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, buffer);
}

export function assetBody(asset: ClassroomAsset): ArrayBuffer {
  return asset.bytes.buffer.slice(
    asset.bytes.byteOffset,
    asset.bytes.byteOffset + asset.bytes.byteLength,
  ) as ArrayBuffer;
}

export async function readClassroomAsset(
  classroomId: string,
  assetPath: string,
): Promise<ClassroomAsset | null> {
  validateAssetLocation(classroomId, assetPath);
  const pool = getServerDatabasePool();
  if (pool) {
    await ensureAssetTable();
    const result = await pool.query<{ bytes: Buffer; content_type: string }>(
      `SELECT bytes, content_type
       FROM openmaic_classroom_assets
       WHERE classroom_id = $1 AND asset_path = $2`,
      [classroomId, assetPath],
    );
    const row = result.rows[0];
    return row ? { bytes: row.bytes, contentType: row.content_type } : null;
  }

  try {
    const bytes = await fs.readFile(path.join(CLASSROOMS_DIR, classroomId, assetPath));
    return { bytes, contentType: contentTypeForPath(assetPath) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export function contentTypeForPath(assetPath: string): string {
  const extension = path.extname(assetPath).toLowerCase();
  return (
    {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
      '.gif': 'image/gif',
      '.mp4': 'video/mp4',
      '.webm': 'video/webm',
      '.mp3': 'audio/mpeg',
      '.wav': 'audio/wav',
      '.ogg': 'audio/ogg',
      '.aac': 'audio/aac',
    }[extension] ?? 'application/octet-stream'
  );
}
