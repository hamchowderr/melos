import { z } from 'zod';

/** Why a write stops for approval (docs/CONTRACT.md §3.2, §3.4). */
export const APPROVAL_KINDS = [
  'rights_change',
  'representation',
  'licensing_contact',
  'identifier_change',
  'external_send',
  'destructive',
  'bulk',
  'possible_duplicate',
  'terminal_status',
] as const;
export type ApprovalKind = (typeof APPROVAL_KINDS)[number];

/**
 * One row of the state a card shows: a party or holder, an optional detail such as roles or an
 * attestation, and a share in basis points where the change is a split. Ids stay for the audit row.
 */
export const approvalRowSchema = z.object({
  id: z.string().min(1),
  label: z.string(),
  detail: z.string().optional(),
  shareBp: z.number().int().nullable().optional(),
});
export type ApprovalRow = z.infer<typeof approvalRowSchema>;

/**
 * What a suspended tool shows the member (§3.4 `ApprovalRequest`): the kind, a one-line summary, the
 * state before and the proposed state after, and the hashes the resume re-checks (§7.4).
 * `contentHash` is set by sendMessage only. Shared by the tools (suspendSchema) and ConfirmationCard.
 */
export const approvalRequestSchema = z.object({
  kind: z.enum(APPROVAL_KINDS),
  toolName: z.string().min(1),
  summary: z.string().min(1),
  before: z.array(approvalRowSchema),
  after: z.array(approvalRowSchema),
  inputHash: z.string().regex(/^[0-9a-f]{64}$/),
  beforeHash: z.string().regex(/^[0-9a-f]{64}$/),
  contentHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  reasons: z.array(z.string().min(1)),
});
export type ApprovalRequest = z.infer<typeof approvalRequestSchema>;

/**
 * The member's answer (§3.4 `ApprovalDecision`), the tool's resumeSchema. Approve and Decline both
 * send it, and closing the card sends `approved: false`, so a decline always resumes the tool
 * (§7.4 step 5, AUD-002). `inputHash` echoes the request's, binding the answer to that call.
 */
export const approvalDecisionSchema = z.object({
  approved: z.boolean(),
  inputHash: z.string().min(1),
  comment: z.string().max(500).optional(),
});
export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;

/** Why a resumed call wrote nothing (`approval.declined`'s reason, AUD-002). */
export type DeclineReason = 'declined' | 'input_mismatch' | 'no_request' | 'already_resolved';
