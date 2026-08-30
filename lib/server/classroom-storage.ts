import { promises as fs } from 'fs';
import path from 'path';
import type { NextRequest } from 'next/server';
import type { Scene, Stage } from '@/lib/types/stage';
import { getServerDatabasePool } from '@/lib/server/postgres';

export const CLASSROOMS_DIR = path.join(process.cwd(), 'data', 'classrooms');
export const CLASSROOM_JOBS_DIR = path.join(process.cwd(), 'data', 'classroom-jobs');

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

export async function ensureClassroomsDir() {
  await ensureDir(CLASSROOMS_DIR);
}

export async function ensureClassroomJobsDir() {
  await ensureDir(CLASSROOM_JOBS_DIR);
}

export async function writeJsonFileAtomic(filePath: string, data: unknown) {
  const dir = path.dirname(filePath);
  await ensureDir(dir);

  const tempFilePath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const content = JSON.stringify(data, null, 2);
  await fs.writeFile(tempFilePath, content, 'utf-8');
  await fs.rename(tempFilePath, filePath);
}

export function buildRequestOrigin(req: NextRequest): string {
  return req.headers.get('x-forwarded-host')
    ? `${req.headers.get('x-forwarded-proto') || 'http'}://${req.headers.get('x-forwarded-host')}`
    : req.nextUrl.origin;
}

export interface PersistedClassroomData {
  id: string;
  stage: Stage;
  scenes: Scene[];
  createdAt: string;
}

let classroomTableReady: Promise<void> | undefined;

async function ensureClassroomTable(): Promise<void> {
  const pool = getServerDatabasePool();
  if (!pool) return;
  classroomTableReady ??= pool
    .query(
      `
      CREATE TABLE IF NOT EXISTS openmaic_generated_classrooms (
        id text PRIMARY KEY,
        payload jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `,
    )
    .then(() => undefined);
  return classroomTableReady;
}

export function isValidClassroomId(id: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(id);
}

export async function readClassroom(id: string): Promise<PersistedClassroomData | null> {
  const pool = getServerDatabasePool();
  if (pool) {
    await ensureClassroomTable();
    const result = await pool.query<{ payload: PersistedClassroomData }>(
      'SELECT payload FROM openmaic_generated_classrooms WHERE id = $1',
      [id],
    );
    return result.rows[0]?.payload ?? null;
  }

  const filePath = path.join(CLASSROOMS_DIR, `${id}.json`);
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content) as PersistedClassroomData;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export async function persistClassroom(
  data: {
    id: string;
    stage: Stage;
    scenes: Scene[];
  },
  baseUrl: string,
): Promise<PersistedClassroomData & { url: string }> {
  const classroomData: PersistedClassroomData = {
    id: data.id,
    stage: data.stage,
    scenes: data.scenes,
    createdAt: new Date().toISOString(),
  };

  const pool = getServerDatabasePool();
  if (pool) {
    await ensureClassroomTable();
    await pool.query(
      `INSERT INTO openmaic_generated_classrooms (id, payload)
       VALUES ($1, $2::jsonb)
       ON CONFLICT (id) DO UPDATE
       SET payload = EXCLUDED.payload, updated_at = now()`,
      [data.id, JSON.stringify(classroomData)],
    );
  } else {
    await ensureClassroomsDir();
    const filePath = path.join(CLASSROOMS_DIR, `${data.id}.json`);
    await writeJsonFileAtomic(filePath, classroomData);
  }

  return {
    ...classroomData,
    url: `${baseUrl}/classroom/${data.id}`,
  };
}
