import { createServerClient, type CookieOptions } from '@supabase/ssr';
import type { NextRequest, NextResponse } from 'next/server';

export interface PendingCookie {
  name: string;
  value: string;
  options: CookieOptions;
}

// NEXT_PUBLIC_* values are normally folded into the Next.js bundle at build
// time. CloudBase injects service variables when the container starts, so use
// dynamic lookup in server-only code to preserve runtime configuration.
function runtimeEnv(name: string): string | undefined {
  return process.env[name];
}

export function isServerAuthConfigured(): boolean {
  return Boolean(runtimeEnv('NEXT_PUBLIC_SUPABASE_URL') && runtimeEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY'));
}

export function createSupabaseRouteClient(request: NextRequest, pendingCookies: PendingCookie[]) {
  const url = runtimeEnv('NEXT_PUBLIC_SUPABASE_URL');
  const anonKey = runtimeEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY');
  if (!url || !anonKey) return undefined;

  return createServerClient(url, anonKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (cookies: PendingCookie[]) => {
        pendingCookies.push(...cookies);
      },
    },
  });
}

export function applyPendingCookies(response: NextResponse, pendingCookies: PendingCookie[]) {
  for (const { name, value, options } of pendingCookies) {
    response.cookies.set(name, value, { ...options, httpOnly: true });
  }
  response.headers.set('Cache-Control', 'private, no-store');
  return response;
}
