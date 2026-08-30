import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { AssetPrincipal } from '@openmaic/storage';
import type { RuntimeHttpPrincipal } from '@openmaic/storage/server';
import { VERIFIED_USER_ID_HEADER } from '@/lib/persistence/auth-headers';

export type PersistencePrincipal = RuntimeHttpPrincipal &
  Pick<AssetPrincipal, 'key'> & { userId?: string };

let serverClient: SupabaseClient | undefined;

function runtimeEnv(name: string): string | undefined {
  return process.env[name];
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function bearerToken(authorization: string | undefined): string | undefined {
  if (!authorization?.startsWith('Bearer ')) return undefined;
  const token = authorization.slice('Bearer '.length).trim();
  return token || undefined;
}

function getServerClient(): SupabaseClient | undefined {
  const url = runtimeEnv('NEXT_PUBLIC_SUPABASE_URL');
  const anonKey = runtimeEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY');
  if (!url || !anonKey) return undefined;
  return (serverClient ??= createClient(url, anonKey, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
  }));
}

function secureEqual(left: string, right: string): boolean {
  const leftDigest = createHash('sha256').update(left).digest();
  const rightDigest = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

async function authenticatePersistenceCredentials(
  authorization: string | undefined,
  legacyLearnerKey: string | undefined,
  verifiedUserId: string | undefined,
): Promise<PersistencePrincipal | undefined> {
  const client = getServerClient();
  if (client && verifiedUserId) {
    return { userId: verifiedUserId, key: verifiedUserId, learnerKey: verifiedUserId };
  }

  const token = bearerToken(authorization);
  if (!token) return undefined;

  if (client) {
    const { data, error } = await client.auth.getUser(token);
    if (error || !data.user) return undefined;
    const userId = data.user.id;
    return { userId, key: userId, learnerKey: userId };
  }

  // Local/trusted-network compatibility only. Public deployments configure
  // Supabase, so browser-supplied learner identity is never trusted there.
  const developmentToken = process.env.PERSISTENCE_DEV_TOKEN;
  if (!developmentToken || !secureEqual(token, developmentToken)) return undefined;
  return { key: 'shared', ...(legacyLearnerKey ? { learnerKey: legacyLearnerKey } : {}) };
}

export function isPersistenceAuthConfigured(): boolean {
  return Boolean(
    (runtimeEnv('NEXT_PUBLIC_SUPABASE_URL') && runtimeEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY')) ||
    process.env.PERSISTENCE_DEV_TOKEN,
  );
}

export async function authenticatePersistenceHeaders(
  headers: Headers,
): Promise<PersistencePrincipal | undefined> {
  return authenticatePersistenceCredentials(
    headers.get('authorization') ?? undefined,
    headers.get('x-learner-key') ?? undefined,
    headers.get(VERIFIED_USER_ID_HEADER) ?? undefined,
  );
}

export async function authenticatePersistenceRequest(
  req: IncomingMessage,
): Promise<PersistencePrincipal | undefined> {
  return authenticatePersistenceCredentials(
    singleHeader(req.headers.authorization),
    singleHeader(req.headers['x-learner-key']),
    singleHeader(req.headers[VERIFIED_USER_ID_HEADER]),
  );
}
