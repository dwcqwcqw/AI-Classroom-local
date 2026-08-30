import { createServerClient, type CookieOptions } from '@supabase/ssr';
import type { NextRequest, NextResponse } from 'next/server';

export interface PendingCookie {
  name: string;
  value: string;
  options: CookieOptions;
}

export function isServerAuthConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}

export function createSupabaseRouteClient(request: NextRequest, pendingCookies: PendingCookie[]) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
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
