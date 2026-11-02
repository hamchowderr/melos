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

export const UPDATE_PUBLISHING_SHARES_TOOL_NAME = 'updatePublishingShares';
export const UPDATE_MASTER_SHARES_TOOL_NAME = 'updateMasterShares';

const agreementId = z.string().min(1).nullable().optional();

export const publishingSharesInputSchema = z.object({
  compositionId: z.string().min(1),
  territory: z
    .string()
    .regex(/^(WORLD|[A-Z]{2})$/)
    .describe('WORLD or an ISO 3166-1 alpha-2 code.'),
  shares: z
    .array(z.object({ publisherPartyId: z.string().min(1), shareBp, agreementId }))
    .describe('The full publishing set for that territory after the change, each publisher once.'),
});

export const masterSharesInputSchema = z.object({
  recordingId: z.string().min(1),
  shares: z
    .array(z.object({ ownerPartyId: z.string().min(1), shareBp, agreementId }))
    .describe('The full master set after the change, each owner once.'),
});

export const ATTEST_REPRESENTATION_TOOL_NAME = 'attestRepresentation';
export const UPDATE_LICENSING_CONTACTS_TOOL_NAME = 'updateLicensingContacts';

export const representationInputSchema = z.object({
  interestType: z.enum(['publishing', 'master']),
  interestId: z
    .string()
    .min(1)
    .describe('The publishing or master interest id from getRightsSummary.'),
  agreementId,
  attested: z.boolean().describe('true attests that the workspace represents it; false clears it.'),
});

export const licensingContactsInputSchema = z
  .object({
    recordingId: z.string().min(1).optional(),
    compositionId: z.string().min(1).optional(),
    contacts: z
      .array(
        z.object({
          partyId: z.string().min(1),
          agreementId,
          notes: z.string().max(2000).nullable().optional(),
        }),
      )
      .describe('The full contact set after the change, each party once.'),
  })
  .refine((input) => !input.recordingId !== !input.compositionId, {
    message: 'exactly one of recordingId and compositionId',
  });
