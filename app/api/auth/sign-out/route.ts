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
  if (client) await client.auth.signOut();
  const response = NextResponse.json<AuthMutationResponse>({
    configured: Boolean(client),
    user: null,
  });
  return applyPendingCookies(response, pendingCookies);
}
