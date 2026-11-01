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

/**
 * The AG-UI context entry naming the entity the chat shows last (U-04, §3.7): set by the song
 * card and rights panel renderers, read by the agent's instructions. A UI hint, never authority:
 * tools look its id up in the active workspace like any other input.
 */
export const FOCUSED_ENTITY_CONTEXT = 'focusedEntity';

export const focusedEntitySchema = z.object({
  entityType: z.enum(['composition', 'recording']),
  entityId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
});

export type FocusedEntity = z.infer<typeof focusedEntitySchema>;
