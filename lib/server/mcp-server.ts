import { nanoid } from 'nanoid';
import { z } from 'zod/v4';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  beginMcpToolCall,
  finishMcpToolCall,
  MCP_SCOPES,
  type McpPrincipal,
} from '@/lib/server/mcp-auth';
import {
  createClassroomGenerationJob,
  readClassroomGenerationJob,
} from '@/lib/server/classroom-job-store';
import { runClassroomGenerationJob } from '@/lib/server/classroom-job-runner';
import { isValidClassroomId, readClassroom } from '@/lib/server/classroom-storage';

type ScheduleWork = (work: () => Promise<void>) => void;

export interface CloudLadderMcpServerOptions {
  principal: McpPrincipal;
  baseUrl: string;
  schedule: ScheduleWork;
}

function asToolResult(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data) }],
    structuredContent: data as Record<string, unknown>,
  };
}

function asToolError(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error);
  const message = raw.startsWith('MCP_SCOPE_DENIED:')
    ? 'This MCP key does not have permission to use this tool.'
    : raw === 'MCP_DAILY_LIMIT_EXCEEDED'
      ? 'This MCP key has reached its daily call limit.'
      : raw === 'MCP_DATABASE_UNAVAILABLE'
        ? 'The MCP database is unavailable.'
        : raw;
  return {
    isError: true,
    content: [{ type: 'text' as const, text: message }],
  };
}

async function runAuditedTool(
  principal: McpPrincipal,
  scope: string,
  toolName: string,
  operation: () => Promise<unknown>,
) {
  let callId: string | undefined;
  try {
    callId = await beginMcpToolCall(principal, scope, toolName);
    const result = await operation();
    await finishMcpToolCall(callId, true);
    return asToolResult(result);
  } catch (error) {
    if (callId) {
      const code = error instanceof Error ? error.message.slice(0, 120) : 'UNKNOWN_ERROR';
      await finishMcpToolCall(callId, false, code).catch(() => undefined);
    }
    return asToolError(error);
  }
}

export function createCloudLadderMcpServer(options: CloudLadderMcpServerOptions): McpServer {
  const server = new McpServer({
    name: 'yunti-course-mcp',
    version: '1.0.0',
    websiteUrl: options.baseUrl,
  });

  server.registerTool(
    'generate_course',
    {
      title: '生成云梯课程',
      description:
        '快速生成一页 3D 可视化、互动模拟、教学游戏、思维导图或测验，立即返回可轮询的 jobId。',
      inputSchema: {
        requirement: z.string().min(3).max(20_000).describe('课程主题、受众和教学要求'),
        page_type: z
          .enum(['visualization3d', 'simulation', 'game', 'mindmap', 'quiz'])
          .optional()
          .describe('页面类型；建议显式传入，不传时从 requirement 自动判断'),
        enable_web_search: z.boolean().optional().default(false).describe('是否启用联网搜索'),
        enable_images: z.boolean().optional().default(false).describe('是否生成课程图片'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ requirement, page_type, enable_web_search, enable_images }) =>
      runAuditedTool(options.principal, MCP_SCOPES.generateCourse, 'generate_course', async () => {
        const jobId = nanoid(10);
        const input = {
          requirement,
          pageType: page_type,
          enableWebSearch: enable_web_search,
          enableImageGeneration: enable_images,
          enableVideoGeneration: false,
          enableTTS: false,
          agentMode: 'default' as const,
        };
        const job = await createClassroomGenerationJob(jobId, input);
        options.schedule(() => runClassroomGenerationJob(jobId, input, options.baseUrl));
        return {
          jobId,
          status: job.status,
          progress: job.progress,
          pollAfterSeconds: 5,
        };
      }),
  );

  server.registerTool(
    'get_generation_status',
    {
      title: '查询课程生成进度',
      description: '使用 generate_course 返回的 jobId 查询进度、错误或最终课程地址。',
      inputSchema: {
        job_id: z.string().min(1).max(128).describe('课程生成任务 ID'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ job_id }) =>
      runAuditedTool(
        options.principal,
        MCP_SCOPES.readCourse,
        'get_generation_status',
        async () => {
          if (!/^[a-zA-Z0-9_-]+$/.test(job_id)) throw new Error('Invalid job_id.');
          const job = await readClassroomGenerationJob(job_id);
          if (!job) throw new Error('Course generation job not found.');
          return {
            jobId: job.id,
            status: job.status,
            step: job.step,
            progress: job.progress,
            message: job.message,
            scenesGenerated: job.scenesGenerated,
            totalScenes: job.totalScenes,
            result: job.result,
            error: job.error,
            done: job.status === 'succeeded' || job.status === 'failed',
          };
        },
      ),
  );

  server.registerTool(
    'get_course',
    {
      title: '读取已生成课程',
      description: '按 classroomId 读取已经保存到云梯的完整课程结构。',
      inputSchema: {
        classroom_id: z.string().min(1).max(128).describe('课程 ID'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ classroom_id }) =>
      runAuditedTool(options.principal, MCP_SCOPES.readCourse, 'get_course', async () => {
        if (!isValidClassroomId(classroom_id)) throw new Error('Invalid classroom_id.');
        const classroom = await readClassroom(classroom_id);
        if (!classroom) throw new Error('Course not found.');
        return {
          classroomId: classroom.id,
          url: `${options.baseUrl}/classroom/${classroom.id}`,
          createdAt: classroom.createdAt,
          stage: classroom.stage,
          scenes: classroom.scenes,
        };
      }),
  );

  return server;
}
