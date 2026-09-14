import { createTool } from '@mastra/core/tools';
import {
  PING_TOOL_NAME,
  type PingResult,
  pingInputSchema,
  pingResultSchema,
} from '../../lib/agent/contract';
import { readTenantContext } from '../request-context';

/** Placeholder read tool: proves the tool sees the caller's workspace from the server session. */
export const pingTool = createTool({
  id: PING_TOOL_NAME,
  description:
    'Check the connection. Returns the active organization and workspace ids, the user id and the workspace role this chat runs as.',
  inputSchema: pingInputSchema,
  outputSchema: pingResultSchema,
  execute: async (_input, context): Promise<PingResult> => {
    const tenant = readTenantContext(context?.requestContext);
    return {
      status: 'ok',
      organizationId: tenant.organizationId,
      workspaceId: tenant.workspaceId,
      userId: tenant.userId,
      workspaceRole: tenant.workspaceRole,
    };
  },
});
