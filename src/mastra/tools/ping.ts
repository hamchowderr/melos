import { createTool } from '@mastra/core/tools';
import {
  PING_TOOL_NAME,
  type PingResult,
  pingInputSchema,
  pingResultSchema,
} from '../../lib/agent/contract';
import { readAgentTenantContext } from '../request-context';

/** Placeholder read tool: proves the tool sees the caller's workspace from the server session. */
export const pingTool = createTool({
  id: PING_TOOL_NAME,
  description:
    'Check the connection. Returns the active workspace id and the user id this chat runs as.',
  inputSchema: pingInputSchema,
  outputSchema: pingResultSchema,
  execute: async (_input, context): Promise<PingResult> => {
    const tenant = readAgentTenantContext(context?.requestContext);
    return {
      status: 'ok',
      workspaceId: tenant.activeOrganizationId,
      userId: tenant.userId,
    };
  },
});
