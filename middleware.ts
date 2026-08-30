import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { NextRequest, NextResponse } from 'next/server';
import { VERIFIED_USER_ID_HEADER } from '@/lib/persistence/auth-headers';

/** Convert string to Uint8Array */
function encode(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

/** Convert ArrayBuffer to hex string */
function bufToHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Verify an HMAC-signed token using Web Crypto API (Edge-compatible) */
async function verifyToken(token: string, accessCode: string): Promise<boolean> {
  const dotIndex = token.indexOf('.');
  if (dotIndex === -1) return false;

  const timestamp = token.substring(0, dotIndex);
  const signature = token.substring(dotIndex + 1);

  const keyData = encode(accessCode);
  const key = await crypto.subtle.importKey(
    'raw',
    keyData.buffer as ArrayBuffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const data = encode(timestamp);
  const expected = bufToHex(await crypto.subtle.sign('HMAC', key, data.buffer as ArrayBuffer));

  // Constant-length comparison (not truly constant-time in JS, but sufficient here)
  if (signature.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < signature.length; i++) {
    mismatch |= signature.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return mismatch === 0;
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const forwardedHeaders = new Headers(request.headers);
  // Never trust a client-supplied internal identity header. It is populated
  // below only after Supabase has verified the HttpOnly session cookie.
  forwardedHeaders.delete(VERIFIED_USER_ID_HEADER);
  const nextResponse = () => NextResponse.next({ request: { headers: forwardedHeaders } });
  let response = nextResponse();
  // CloudBase provides service variables at container runtime. Dynamic access
  // prevents Next.js from replacing NEXT_PUBLIC_* with build-time empties.
  const supabaseUrl = process.env['NEXT_PUBLIC_SUPABASE_URL'];
  const supabaseAnonKey = process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY'];
  const accessCode = process.env.ACCESS_CODE;

  // Public interactive classrooms use a single-response viewer. Rewriting at
  // the edge bypasses the full editor application shell (providers, fonts,
  // Tailwind bundle and many JS chunks), which is especially important on
  // high-latency mainland mobile connections. Non-interactive classrooms opt
  // back into the normal React viewer through the internal `full` flag.
  const publicClassroomMatch = pathname.match(/^\/classroom\/([a-zA-Z0-9_-]+)\/?$/);
  if (
    request.method === 'GET' &&
    publicClassroomMatch &&
    !request.nextUrl.searchParams.has('full')
  ) {
    const viewerUrl = request.nextUrl.clone();
    viewerUrl.pathname = `/public-classroom/${publicClassroomMatch[1]}`;
    return NextResponse.rewrite(viewerUrl, { request: { headers: forwardedHeaders } });
  }

  // A classroom URL is an unguessable public share link. Only the exact
  // read-only APIs required to render it are public; generation, settings,
  // chat, saves, and every mutation remain session-protected.
  const isPublicClassroomRead =
    request.method === 'GET' &&
    (pathname === '/api/classroom' ||
      pathname.startsWith('/api/classroom-media/') ||
      pathname.startsWith('/api/classroom-audio/'));
  if (isPublicClassroomRead) {
    return response;
  }

  // Whitelist: access-code endpoints, health check, and the MCP endpoint. MCP
  // performs its own bearer-token authentication in the route handler.
  if (
    pathname.startsWith('/api/access-code/') ||
    pathname.startsWith('/api/auth/') ||
    pathname === '/api/health' ||
    pathname === '/api/mcp'
  ) {
    return response;
  }

  // Ordinary pages render the local login shell without a cross-border auth
  // round trip. The shell checks its session through /api/auth/session.
  if (!pathname.startsWith('/api/')) return response;

  if (supabaseUrl && supabaseAnonKey) {
    const pendingCookies: Array<{ name: string; value: string; options: CookieOptions }> = [];
    const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (cookies: Array<{ name: string; value: string; options: CookieOptions }>) => {
          pendingCookies.push(...cookies);
        },
      },
    });
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json(
        { success: false, errorCode: 'UNAUTHENTICATED', error: 'Sign in required' },
        { status: 401, headers: { 'Cache-Control': 'private, no-store' } },
      );
    }
    forwardedHeaders.set(VERIFIED_USER_ID_HEADER, user.id);
    response = nextResponse();
    for (const { name, value, options } of pendingCookies) {
      response.cookies.set(name, value, { ...options, httpOnly: true });
    }
  }

  if (!accessCode) {
    return response;
  }

  // Check cookie — validate HMAC signature, not just existence
  const cookie = request.cookies.get('openmaic_access');
  if (cookie?.value && (await verifyToken(cookie.value, accessCode))) {
    return response;
  }

  // API requests without valid cookie → 401
  if (pathname.startsWith('/api/')) {
    return NextResponse.json(
      { success: false, errorCode: 'INVALID_REQUEST', error: 'Access code required' },
      { status: 401 },
    );
  }

  // Page requests → let through, frontend shows modal
  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|logos/).*)'],
};
