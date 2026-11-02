import { z } from 'zod';
import { WRITER_ROLES } from '../dto/rights';

/** Sensitive rights write tool names and inputs (docs/CONTRACT.md §3.3, §6.3). Zod only. */
export const UPDATE_WRITER_SHARES_TOOL_NAME = 'updateWriterShares';

const shareBp = z.number().int().min(0).max(10_000).describe('Basis points: 10000 = 100%.');

export const writerSharesInputSchema = z.object({
  compositionId: z.string().min(1),
  shares: z
    .array(
      z.object({
        partyId: z.string().min(1),
        roles: z.array(z.enum(WRITER_ROLES)).min(1).max(WRITER_ROLES.length),
        shareBp: shareBp.nullable(),
      }),
    )
    .describe('The full writer set after the change, each party once, not only the changed rows.'),
});
