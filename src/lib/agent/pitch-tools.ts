import { z } from 'zod';
import { PITCH_STATUSES } from '../dto/pitches';

/** Pitch read tool names and inputs (docs/CONTRACT.md §3.3). Zod only. */
export const SEARCH_PITCHES_TOOL_NAME = 'searchPitches';
export const GET_PITCH_TOOL_NAME = 'getPitch';
export const GET_MESSAGE_THREAD_TOOL_NAME = 'getMessageThread';
export const GET_TODAY_WORKSPACE_TOOL_NAME = 'getTodayWorkspace';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');

export const searchPitchesInputSchema = z.object({
  statuses: z
    .array(z.enum(PITCH_STATUSES))
    .optional()
    .describe('Keep these cell statuses. Archived cells are left out unless named.'),
  contactId: z.string().min(1).optional(),
  itemType: z.enum(['composition', 'recording']).optional(),
  itemId: z
    .string()
    .min(1)
    .optional()
    .describe('With itemType; a composition covers its recordings.'),
  followUpDueOn: date.optional().describe('Only cells with a follow-up due on this date.'),
});

export const getPitchInputSchema = z.object({ pitchId: z.string().min(1) });

export const getMessageThreadInputSchema = z.object({
  messageId: z.string().min(1).optional().describe('Give this or pitchId, not both.'),
  pitchId: z.string().min(1).optional(),
});

export const getTodayWorkspaceInputSchema = z.object({
  date: date.optional().describe("Default today in the member's timezone."),
});
