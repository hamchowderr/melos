import { z } from 'zod';

/** Contact and pitch read tool names and inputs (docs/CONTRACT.md §3.3). Zod only. */
export const SEARCH_CONTACTS_TOOL_NAME = 'searchContacts';
export const GET_CONTACT_TOOL_NAME = 'getContact';

export const pitchItemRefSchema = z.object({
  itemType: z.enum(['composition', 'recording']),
  itemId: z.string().min(1),
});

export const searchContactsInputSchema = z.object({
  query: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe('Part of a contact name, company name or email address.'),
  roles: z.array(z.string().min(1)).optional().describe('Keep contacts with any of these roles.'),
  hasPitchFor: pitchItemRefSchema.optional().describe('Keep contacts pitched this song.'),
  limit: z.number().int().min(1).max(100).optional().describe('Default 50.'),
});

export const getContactInputSchema = z.object({ contactId: z.string().min(1) });

export const SEARCH_PITCH_ELIGIBILITY_TOOL_NAME = 'searchPitchEligibility';

export const searchPitchEligibilityInputSchema = pitchItemRefSchema.describe(
  'The song: a composition id, or a recording id for one version.',
);
