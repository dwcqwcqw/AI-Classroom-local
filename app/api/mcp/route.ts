import { after, type NextRequest } from 'next/server';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { authenticateMcpRequest } from '@/lib/server/mcp-auth';
import { createCloudLadderMcpServer } from '@/lib/server/mcp-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers':
    'Authorization, Content-Type, Accept, Last-Event-ID, Mcp-Session-Id, Mcp-Protocol-Version, Mcp-Method, Mcp-Name',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id, Mcp-Protocol-Version',
};

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(CORS_HEADERS)) headers.set(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function unauthorized(): Response {
  return withCors(
    Response.json(
      {
        jsonrpc: '2.0',
        error: { code: -32001, message: 'A valid 云梯 MCP bearer token is required.' },
        id: null,
      },
      {
        status: 401,
        headers: { 'WWW-Authenticate': 'Bearer realm="云梯 MCP"' },
      },
    ),
  );
}

function requestOrigin(request: NextRequest): string {
  const forwardedHost = request.headers.get('x-forwarded-host');
  return forwardedHost
    ? `${request.headers.get('x-forwarded-proto') || 'https'}://${forwardedHost}`
    : request.nextUrl.origin;
}

async function handleMcpRequest(request: NextRequest): Promise<Response> {
  const principal = await authenticateMcpRequest(request);
  if (!principal) return unauthorized();

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  const server = createCloudLadderMcpServer({
    principal,
    baseUrl: requestOrigin(request),
    schedule: (work) => after(work),
  });

  await server.connect(transport);
  return withCors(await transport.handleRequest(request));
}

export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export const GET = handleMcpRequest;
export const POST = handleMcpRequest;
export const DELETE = handleMcpRequest;
