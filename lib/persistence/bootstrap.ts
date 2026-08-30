import {
  BrowserKVStore,
  HttpAssetStore,
  HttpDocumentStore,
  type HttpAssetHeadersHook,
  type HttpDocumentHeadersHook,
} from '@openmaic/storage';
import { HttpRuntimeStore, type HttpRuntimeHeadersHook } from '@openmaic/storage/runtime/http';

import {
  assertDocumentStorageConfigurable,
  configureDocumentStorage,
  type DocumentStorageOptions,
} from '@/lib/document-store/config';
import {
  assertAssetPoolStorageConfigurable,
  configureAssetPoolStorage,
  type AssetPoolStorageOptions,
} from '@/lib/media/asset-pool-config';
import { assertRuntimeStorageConfigurable, configureRuntimeStorage } from '@/lib/runtime/config';
import { getLearnerKey } from '@/lib/runtime/learner-key';
import { getAuthSession } from '@/lib/auth/client';
import type { AuthSessionResponse } from '@/lib/auth/types';

let deviceKv: BrowserKVStore | undefined;
let learnerKeyPromise: Promise<string> | undefined;
let authSessionPromise: Promise<AuthSessionResponse> | undefined;

function getCachedAuthSession(): Promise<AuthSessionResponse> {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    return Promise.resolve({ configured: false, user: null });
  }
  return (authSessionPromise ??= getAuthSession().catch((error) => {
    authSessionPromise = undefined;
    throw error;
  }));
}

export function isBrowserPersistenceEnabled(): boolean {
  return typeof window !== 'undefined' && process.env.NEXT_PUBLIC_PERSISTENCE === '1';
}

export function getPersistenceLearnerKey(): Promise<string> {
  if (!isBrowserPersistenceEnabled()) {
    return Promise.reject(new Error('Browser persistence is not enabled'));
  }
  return getCachedAuthSession().then((session) => {
    if (session.configured) {
      if (!session.user) throw new Error('Authentication is required for persistence');
      return session.user.id;
    }
    return (learnerKeyPromise ??= getLearnerKey((deviceKv ??= new BrowserKVStore())).catch(
      (error) => {
        learnerKeyPromise = undefined;
        throw error;
      },
    ));
  });
}

export async function getPersistenceRequestHeaders(): Promise<Record<string, string>> {
  if (!isBrowserPersistenceEnabled()) return {};
  const [resolvedLearnerKey, session] = await Promise.all([
    getPersistenceLearnerKey(),
    getCachedAuthSession(),
  ]);
  // The browser sends only the same-origin session cookie. Middleware validates
  // it and injects the authoritative user id before the persistence handler.
  if (session.configured) return { 'x-learner-key': resolvedLearnerKey };
  const token = process.env.NEXT_PUBLIC_PERSISTENCE_TOKEN;
  return {
    'x-learner-key': resolvedLearnerKey,
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

if (isBrowserPersistenceEnabled()) {
  const learnerKey = getPersistenceLearnerKey;
  const headers = getPersistenceRequestHeaders;

  const runtimeOptions = {
    store: () =>
      new HttpRuntimeStore({
        baseUrl: '/api/persistence',
        headers: headers satisfies HttpRuntimeHeadersHook,
      }),
    learnerKey,
  };
  const documentOptions: DocumentStorageOptions = {
    store: ({ validateScene, validateStage }) =>
      new HttpDocumentStore({
        baseUrl: '/api/persistence',
        headers: headers satisfies HttpDocumentHeadersHook,
        validateScene,
        validateStage,
      }),
  };
  const assetOptions: AssetPoolStorageOptions = {
    store: () =>
      new HttpAssetStore({
        baseUrl: '/api/persistence',
        headers: headers satisfies HttpAssetHeadersHook,
      }),
    serverBacked: true,
  };

  try {
    // All checks are mutation-free. Once they pass, the synchronous configure
    // calls cannot leave only a subset of the persistence seams configured.
    assertRuntimeStorageConfigurable();
    assertDocumentStorageConfigurable();
    assertAssetPoolStorageConfigurable();
    configureRuntimeStorage(runtimeOptions);
    configureDocumentStorage(documentOptions);
    configureAssetPoolStorage(assetOptions);
  } catch (error) {
    console.error(
      'FATAL: server-backed persistence bootstrap failed; no storage seam changes were applied',
      error,
    );
  }
}
