import { NextRequest, NextResponse } from 'next/server';

import type { AuthMutationResponse } from '@/lib/auth/types';
import {
  applyPendingCookies,
  createSupabaseRouteClient,
  type PendingCookie,
} from '@/lib/supabase/route-client';

export async function POST(request: NextRequest) {
  const pendingCookies: PendingCookie[] = [];
  const client = createSupabaseRouteClient(request, pendingCookies);
  if (!client) {
    return NextResponse.json<AuthMutationResponse>(
      { configured: false, user: null, error: 'Authentication is not configured' },
      { status: 503 },
    );
  }

  const body = (await request.json().catch(() => null)) as {
    email?: unknown;
    password?: unknown;
  } | null;
  if (typeof body?.email !== 'string' || typeof body.password !== 'string') {
    return NextResponse.json<AuthMutationResponse>(
      { configured: true, user: null, error: 'Invalid credentials' },
      { status: 400 },
    );
  }

  const callbackUrl = new URL('/api/auth/callback', request.nextUrl.origin);
  callbackUrl.searchParams.set('next', '/workspace');
  const { data, error } = await client.auth.signUp({
    email: body.email.trim(),
    password: body.password,
    options: { emailRedirectTo: callbackUrl.toString() },
  });
  const response = error
    ? NextResponse.json<AuthMutationResponse>(
        { configured: true, user: null, error: error.message },
        { status: 400 },
      )
    : NextResponse.json<AuthMutationResponse>({
        configured: true,
        user:
          data.session && data.user ? { id: data.user.id, email: data.user.email ?? null } : null,
        needsEmailConfirmation: !data.session,
      });
  return applyPendingCookies(response, pendingCookies);
}
