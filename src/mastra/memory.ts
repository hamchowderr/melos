import { Memory } from '@mastra/memory';
import { z } from 'zod';

/**
 * What the agent may remember about a member across threads (docs/CONTRACT.md §7.3): preferences
 * only. Catalog, rights and contact facts always come from tools, never from memory (TS §23).
 */
export const workingMemorySchema = z.object({
  tone: z.string().max(200).optional().describe('How the member likes replies written.'),
  signature: z.string().max(500).optional().describe('Sign-off for drafted messages.'),
  preferredReportPreset: z
    .enum(['full', 'sans_lyrics', 'just_lyrics', 'disco_track_info'])
    .optional()
    .describe('Report preset to use when the member names none.'),
});

/**
 * Memory for the workspace agent. The resource is `<workspaceId>:<userId>` (TEN-007), so working
 * memory in resource scope follows one member in one workspace across threads. Semantic recall
 * stays off (P-12); if enabled later it must use `scope: 'resource'`.
 */
export function createAgentMemory(): Memory {
  return new Memory({
    options: {
      lastMessages: 20,
      semanticRecall: false,
      workingMemory: { enabled: true, scope: 'resource', schema: workingMemorySchema },
    },
  });
}
