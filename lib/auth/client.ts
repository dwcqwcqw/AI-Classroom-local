import type { AuthMutationResponse, AuthSessionResponse } from '@/lib/auth/types';

async function readJson<T>(response: Response): Promise<T> {
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

export async function getAuthSession(signal?: AbortSignal): Promise<AuthSessionResponse> {
  return readJson<AuthSessionResponse>(
    await fetch('/api/auth/session', { cache: 'no-store', credentials: 'same-origin', signal }),
  );
}

async function mutateAuth(
  path: string,
  body?: Record<string, string>,
): Promise<AuthMutationResponse> {
  return readJson<AuthMutationResponse>(
    await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }),
  );
}

export function signIn(email: string, password: string): Promise<AuthMutationResponse> {
  return mutateAuth('/api/auth/sign-in', { email, password });
}

export function signUp(email: string, password: string): Promise<AuthMutationResponse> {
  return mutateAuth('/api/auth/sign-up', { email, password });
}

export function signOut(): Promise<AuthMutationResponse> {
  return mutateAuth('/api/auth/sign-out');
}
