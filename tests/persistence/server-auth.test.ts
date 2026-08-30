import type { IncomingMessage } from 'node:http';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { authenticatePersistenceRequest } from '@/lib/persistence/server-auth';
import { VERIFIED_USER_ID_HEADER } from '@/lib/persistence/auth-headers';

function request(headers: IncomingMessage['headers']): IncomingMessage {
  return { headers } as IncomingMessage;
}

describe('embedded persistence development authentication', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv('PERSISTENCE_DEV_TOKEN', 'shared-secret');
  });

  it('accepts the configured bearer token and learner partition', async () => {
    await expect(
      authenticatePersistenceRequest(
        request({
          authorization: 'Bearer shared-secret',
          'x-learner-key': 'anon:learner-1',
        }),
      ),
    ).resolves.toEqual({ key: 'shared', learnerKey: 'anon:learner-1' });
  });

  it('shares one asset principal across learner keys, like the global documents', async () => {
    const first = await authenticatePersistenceRequest(
      request({ authorization: 'Bearer shared-secret', 'x-learner-key': 'anon:a' }),
    );
    const second = await authenticatePersistenceRequest(
      request({ authorization: 'Bearer shared-secret', 'x-learner-key': 'anon:b' }),
    );
    expect(first?.key).toBe('shared');
    expect(second?.key).toBe('shared');
    expect(first?.learnerKey).not.toBe(second?.learnerKey);
  });

  it('issues the shared asset principal even without a learner key', async () => {
    await expect(
      authenticatePersistenceRequest(request({ authorization: 'Bearer shared-secret' })),
    ).resolves.toEqual({ key: 'shared' });
  });

  it('rejects missing and incorrect bearer tokens', async () => {
    await expect(authenticatePersistenceRequest(request({}))).resolves.toBeUndefined();
    await expect(
      authenticatePersistenceRequest(request({ authorization: 'Bearer shared-secreu' })),
    ).resolves.toBeUndefined();
  });

  it('accepts only middleware-verified identity when Supabase is configured', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://project.supabase.co');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon-key');
    const userId = 'a91b1cc5-254a-4358-a0f4-aad0bee5c453';

    await expect(
      authenticatePersistenceRequest(
        request({
          [VERIFIED_USER_ID_HEADER]: userId,
          'x-learner-key': 'attacker-controlled',
        }),
      ),
    ).resolves.toEqual({ userId, key: userId, learnerKey: userId });
  });
});
