import { NextRequest, NextResponse } from 'next/server';

import {
  applyPendingCookies,
  createSupabaseRouteClient,
  type PendingCookie,
} from '@/lib/supabase/route-client';

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code');
  const requestedNext = request.nextUrl.searchParams.get('next');
  const next =
    requestedNext?.startsWith('/') && !requestedNext.startsWith('//')
      ? requestedNext
      : '/workspace';
  const pendingCookies: PendingCookie[] = [];
  const client = createSupabaseRouteClient(request, pendingCookies);

  if (client && code) {
    const { error } = await client.auth.exchangeCodeForSession(code);
    if (!error) {
      return applyPendingCookies(
        NextResponse.redirect(new URL(next, request.nextUrl.origin)),
        pendingCookies,
      );
    }
  }
  return applyPendingCookies(
    NextResponse.redirect(new URL('/?auth_error=callback', request.nextUrl.origin)),
    pendingCookies,
  );
}
