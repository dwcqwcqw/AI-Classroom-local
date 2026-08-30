import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createCloudLadderMcpServer } from '@/lib/server/mcp-server';
import { hashMcpToken, readBearerToken } from '@/lib/server/mcp-auth';

const closeables: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(closeables.splice(0).map((item) => item.close()));
});

describe('云梯 MCP server', () => {
  it('publishes the three external course tools', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createCloudLadderMcpServer({
      principal: {
        id: 'test-key',
        name: 'test',
        scopes: ['courses:generate', 'courses:read'],
        dailyLimit: 100,
      },
      baseUrl: 'https://onlineteacher.tech',
      schedule: () => undefined,
    });
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    closeables.push(client, server);

    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = await client.listTools();

    expect(tools.tools.map((tool) => tool.name)).toEqual([
      'generate_course',
      'get_generation_status',
      'get_course',
    ]);
  });

  it('hashes bearer tokens without retaining the plaintext', () => {
    const token = 'ymcp_example-secret';
    const request = new Request('https://onlineteacher.tech/api/mcp', {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(readBearerToken(request)).toBe(token);
    expect(hashMcpToken(token)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashMcpToken(token)).not.toContain(token);
  });
});
