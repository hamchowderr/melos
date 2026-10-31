import { z } from 'zod';
import { READINESS_FILTERS } from '../dto/catalog';

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
