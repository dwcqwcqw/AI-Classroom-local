import { NextRequest, NextResponse } from 'next/server';

import type { AuthSessionResponse } from '@/lib/auth/types';
import {
  applyPendingCookies,
  createSupabaseRouteClient,
  isServerAuthConfigured,
  type PendingCookie,
} from '@/lib/supabase/route-client';

export async function GET(request: NextRequest) {
  const pendingCookies: PendingCookie[] = [];
  const client = createSupabaseRouteClient(request, pendingCookies);
  if (!client) {
    return NextResponse.json<AuthSessionResponse>({ configured: false, user: null });
  }

  const { data, error } = await client.auth.getUser();
  const response = NextResponse.json<AuthSessionResponse>({
    configured: isServerAuthConfigured(),
    user: error || !data.user ? null : { id: data.user.id, email: data.user.email ?? null },
  });
  return applyPendingCookies(response, pendingCookies);
}
