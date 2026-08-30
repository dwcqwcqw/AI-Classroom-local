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

  const { data, error } = await client.auth.signInWithPassword({
    email: body.email.trim(),
    password: body.password,
  });
  const response = error
    ? NextResponse.json<AuthMutationResponse>(
        { configured: true, user: null, error: error.message },
        { status: 401 },
      )
    : NextResponse.json<AuthMutationResponse>({
        configured: true,
        user: data.user ? { id: data.user.id, email: data.user.email ?? null } : null,
      });
  return applyPendingCookies(response, pendingCookies);
}
