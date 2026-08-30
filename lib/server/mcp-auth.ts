import { createHash, timingSafeEqual } from 'node:crypto';
import type { Pool } from 'pg';
import { getServerDatabasePool } from '@/lib/server/postgres';

export const MCP_SCOPES = {
  generateCourse: 'courses:generate',
  readCourse: 'courses:read',
} as const;

export interface McpPrincipal {
  id: string;
  name: string;
  scopes: string[];
  dailyLimit: number;
}

let schemaReady: Promise<void> | undefined;

export function hashMcpToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function readBearerToken(request: Request): string | undefined {
  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ')) return undefined;
  const token = authorization.slice('Bearer '.length).trim();
  return token || undefined;
}

async function ensureMcpSchema(pool: Pool): Promise<void> {
  schemaReady ??= (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS openmaic_mcp_api_keys (
        id text PRIMARY KEY,
        name text NOT NULL,
        token_hash text NOT NULL UNIQUE,
        scopes text[] NOT NULL DEFAULT ARRAY['courses:generate', 'courses:read']::text[],
        daily_limit integer NOT NULL DEFAULT 100 CHECK (daily_limit > 0),
        created_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz,
        revoked_at timestamptz,
        last_used_at timestamptz
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS openmaic_mcp_api_calls (
        id bigserial PRIMARY KEY,
        key_id text NOT NULL REFERENCES openmaic_mcp_api_keys(id) ON DELETE CASCADE,
        tool_name text NOT NULL,
        success boolean NOT NULL DEFAULT false,
        error_code text,
        created_at timestamptz NOT NULL DEFAULT now(),
        completed_at timestamptz
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS openmaic_mcp_api_calls_key_created_idx
      ON openmaic_mcp_api_calls (key_id, created_at DESC)
    `);
  })();
  return schemaReady;
}

function secureHashEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'hex');
  const rightBuffer = Buffer.from(right, 'hex');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export async function authenticateMcpRequest(request: Request): Promise<McpPrincipal | undefined> {
  const token = readBearerToken(request);
  const pool = getServerDatabasePool();
  if (!token || !pool) return undefined;

  await ensureMcpSchema(pool);
  const digest = hashMcpToken(token);
  const result = await pool.query<{
    id: string;
    name: string;
    token_hash: string;
    scopes: string[];
    daily_limit: number;
  }>(
    `SELECT id, name, token_hash, scopes, daily_limit
       FROM openmaic_mcp_api_keys
      WHERE token_hash = $1
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > now())
      LIMIT 1`,
    [digest],
  );

  const row = result.rows[0];
  if (!row || !secureHashEqual(row.token_hash, digest)) return undefined;

  await pool.query('UPDATE openmaic_mcp_api_keys SET last_used_at = now() WHERE id = $1', [row.id]);
  return {
    id: row.id,
    name: row.name,
    scopes: row.scopes,
    dailyLimit: row.daily_limit,
  };
}

export async function beginMcpToolCall(
  principal: McpPrincipal,
  requiredScope: string,
  toolName: string,
): Promise<string> {
  if (!principal.scopes.includes(requiredScope)) {
    throw new Error(`MCP_SCOPE_DENIED:${requiredScope}`);
  }

  const pool = getServerDatabasePool();
  if (!pool) throw new Error('MCP_DATABASE_UNAVAILABLE');
  await ensureMcpSchema(pool);

  const usage = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM openmaic_mcp_api_calls
      WHERE key_id = $1
        AND created_at >= date_trunc('day', now())`,
    [principal.id],
  );
  if (Number(usage.rows[0]?.count ?? 0) >= principal.dailyLimit) {
    throw new Error('MCP_DAILY_LIMIT_EXCEEDED');
  }

  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO openmaic_mcp_api_calls (key_id, tool_name)
     VALUES ($1, $2)
     RETURNING id::text`,
    [principal.id, toolName],
  );
  return inserted.rows[0].id;
}

export async function finishMcpToolCall(
  callId: string,
  success: boolean,
  errorCode?: string,
): Promise<void> {
  const pool = getServerDatabasePool();
  if (!pool) return;
  await pool.query(
    `UPDATE openmaic_mcp_api_calls
        SET success = $2, error_code = $3, completed_at = now()
      WHERE id = $1`,
    [callId, success, errorCode ?? null],
  );
}
