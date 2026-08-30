import { beforeEach, describe, expect, it, vi } from 'vitest';

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, String(value)),
  } as Storage;
}

describe('persistence same-origin authentication', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('uses the session cookie without exposing a Supabase bearer token', async () => {
    vi.stubEnv('NEXT_PUBLIC_PERSISTENCE', '1');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://project.supabase.co');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon-key');
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    vi.stubGlobal('localStorage', memoryStorage());
    vi.stubGlobal('document', {
      addEventListener: vi.fn(),
      visibilityState: 'visible',
    });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          configured: true,
          user: { id: 'user-123', email: 'teacher@example.com' },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const runtime = await import('@/lib/runtime/store');
    const documents = await import('@/lib/document-store');
    const assets = await import('@/lib/media/asset-pool');
    const runtimeStore = runtime.getRuntimeStore();
    const headers = await (
      runtimeStore as unknown as {
        headersHook: (context: { method: string; path: string }) => Promise<HeadersInit>;
      }
    ).headersHook({ method: 'GET', path: '/runtime/sessions/example' });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/auth/session');
    expect(new Headers(headers).get('authorization')).toBeNull();
    expect(new Headers(headers).get('x-learner-key')).toBe('user-123');

    runtime.resetRuntimeStorageForTests();
    documents.resetDocumentStorageForTests();
    assets.resetAssetPoolStorageForTests();
  });
});
