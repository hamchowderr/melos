import { z } from 'zod';

/** Shared by the Mastra agent (server) and the chat UI (browser). Zod only, no server code. */
export const WORKSPACE_AGENT_ID = 'melos';
export const PING_TOOL_NAME = 'ping';

export const pingInputSchema = z.object({});

export const pingResultSchema = z.object({
  status: z.literal('ok'),
  workspaceId: z.string(),
  userId: z.string(),
});

export type PingResult = z.infer<typeof pingResultSchema>;
