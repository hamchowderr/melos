import { z } from 'zod';

/** Shared by the Mastra agent (server) and the chat UI (browser). Zod only, no server code. */
export const WORKSPACE_AGENT_ID = 'melos';
export const PING_TOOL_NAME = 'ping';
/** The custom AG-UI event a connect emits for a run still going on another instance (§7.9). */
export const RUN_PENDING_EVENT = 'melos.run_pending';

export const pingInputSchema = z.object({});

export const pingResultSchema = z.object({
  status: z.literal('ok'),
  organizationId: z.string(),
  workspaceId: z.string(),
  userId: z.string(),
  workspaceRole: z.string(),
});

export type PingResult = z.infer<typeof pingResultSchema>;
