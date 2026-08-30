#!/usr/bin/env node
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import process from 'node:process';
import pg from 'pg';

const { Pool } = pg;
const [command = 'create', ...args] = process.argv.slice(2);

function option(name, fallback) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
}

const connectionString = process.env.DATABASE_URL?.trim();
if (!connectionString) {
  throw new Error('DATABASE_URL is required.');
}

const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 10_000 });

async function ensureSchema() {
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
}

async function createToken() {
  const name = option('name', 'external-course-client');
  const dailyLimit = Number.parseInt(option('daily-limit', '100'), 10);
  const expiresDays = option('expires-days');
  if (!Number.isInteger(dailyLimit) || dailyLimit < 1) {
    throw new Error('--daily-limit must be a positive integer.');
  }
  if (
    expiresDays !== undefined &&
    (!Number.isFinite(Number(expiresDays)) || Number(expiresDays) <= 0)
  ) {
    throw new Error('--expires-days must be a positive number.');
  }

  const id = randomUUID();
  const token = `ymcp_${randomBytes(32).toString('base64url')}`;
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const expiresAt = expiresDays
    ? new Date(Date.now() + Number(expiresDays) * 86_400_000).toISOString()
    : null;

  await pool.query(
    `INSERT INTO openmaic_mcp_api_keys
      (id, name, token_hash, scopes, daily_limit, expires_at)
     VALUES ($1, $2, $3, $4::text[], $5, $6)`,
    [id, name, tokenHash, ['courses:generate', 'courses:read'], dailyLimit, expiresAt],
  );

  process.stdout.write(`${JSON.stringify({ id, name, token, dailyLimit, expiresAt }, null, 2)}\n`);
}

async function revokeToken() {
  const id = option('id');
  if (!id) throw new Error('revoke requires --id <token-id>.');
  const result = await pool.query(
    'UPDATE openmaic_mcp_api_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL',
    [id],
  );
  process.stdout.write(`${JSON.stringify({ id, revoked: result.rowCount === 1 })}\n`);
}

try {
  await ensureSchema();
  if (command === 'create') await createToken();
  else if (command === 'revoke') await revokeToken();
  else throw new Error('Usage: manage-mcp-token.mjs <create|revoke> [options]');
} finally {
  await pool.end();
}
