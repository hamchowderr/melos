import { z } from 'zod';
import { READINESS_FILTERS } from '../dto/catalog';
import { SELF_PARTY_SIDES } from '../dto/self-parties';

/** Catalog read tool names and inputs (docs/CONTRACT.md §3.3). Zod only, no server code. */
export const SEARCH_MUSIC_TOOL_NAME = 'searchMusic';
export const GET_MUSIC_WORKSPACE_TOOL_NAME = 'getMusicWorkspace';

export const searchMusicInputSchema = z.object({
  query: z.string().min(1).max(200).describe('Song title, alternate title, artist or other text.'),
  limit: z.number().int().min(1).max(20).optional().describe('Most results to return; default 10.'),
  readiness: z.enum(READINESS_FILTERS).optional(),
  artistPartyId: z.string().min(1).optional(),
  termIds: z.array(z.string().min(1)).optional(),
});

export const catalogFocusSchema = z.object({
  entityType: z.enum(['composition', 'recording']),
  entityId: z.string().min(1),
});

/** Rights read tool names and inputs (docs/CONTRACT.md §3.3). */
export const GET_RIGHTS_SUMMARY_TOOL_NAME = 'getRightsSummary';
export const GET_READINESS_ISSUES_TOOL_NAME = 'getReadinessIssues';
export const PROPOSE_DEFAULT_OWNERSHIP_TOOL_NAME = 'proposeDefaultOwnership';

export const readinessIssuesInputSchema = z.object({
  recordingId: z.string().min(1).optional().describe('One recording.'),
  compositionId: z.string().min(1).optional().describe('Every live recording of a composition.'),
  onlyNotReady: z
    .boolean()
    .optional()
    .describe('Keep only recordings not sync ready; default true.'),
  limit: z.number().int().min(1).max(200).optional().describe('Default 50.'),
});

export const defaultOwnershipInputSchema = z
  .object({
    compositionId: z.string().min(1).optional(),
    recordingId: z.string().min(1).optional(),
    sides: z.array(z.enum(SELF_PARTY_SIDES)).min(1).optional().describe('Default: all three.'),
  })
  .refine((input) => input.compositionId || input.recordingId, {
    message: 'compositionId or recordingId is required',
  });
