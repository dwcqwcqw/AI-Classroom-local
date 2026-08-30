import { Pool } from 'pg';

const globalForPostgres = globalThis as typeof globalThis & {
  __openmaicServerPool?: Pool;
};

/**
 * Shared, server-only PostgreSQL pool. Vercel reuses it while an instance is warm;
 * local builds without DATABASE_URL continue to use the filesystem fallbacks.
 */
export function getServerDatabasePool(): Pool | undefined {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) return undefined;

  return (globalForPostgres.__openmaicServerPool ??= new Pool({
    connectionString,
    max: 2,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  }));
}
