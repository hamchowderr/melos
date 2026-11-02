import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import {
  type ApprovalRequest,
  approvalRequestSchema,
  type DeclineReason,
} from '../../lib/agent/approval';
import type { WorkspacePermissions } from '../../lib/auth/permissions';
import { auditLog } from '../db/schema/workspace.generated';
import { canonicalJson } from './audit-writer';
import { requirePermission } from './permissions';
import { failure, type ServiceResult, success } from './service-result';
import type { TenantContext } from './tenant-context';
import { getWorkspaceDatabase, sanitized } from './workspace-connections';
import { approvalOutcomeOf, runWorkspaceWrite } from './workspace-write';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** `inputHash` (§7.4 step 1): SHA-256 of the canonical JSON of the tool name and its input. */
export const inputHashOf = (toolName: string, input: unknown) =>
  sha256(canonicalJson({ input, toolName }));

/** The entity an approval is about, the audit rows' entity. */
export type ApprovalTarget = { entityType: string; entityId: string };

/** The agent tool call an approval belongs to (`audit_log.approval_tool_call_id`, AUD-002). */
const agent = (toolCallId: string) => ({ type: 'agent' as const, approvalToolCallId: toolCallId });

/**
 * Audits `approval.requested` (§7.4 step 2) in its own write, before the tool suspends, with the
 * full request as its after state. Needs the permissions of the write being approved, so a role
 * that may not make the change is FORBIDDEN and never sees a card (SA Gate E).
 */
export function recordApprovalRequest(
  tenant: TenantContext,
  permissions: WorkspacePermissions,
  toolCallId: string,
  target: ApprovalTarget,
  request: ApprovalRequest,
): Promise<ServiceResult<null>> {
  return runWorkspaceWrite(
    tenant,
    permissions,
    async (_, audit) => {
      await audit.write({ action: 'approval.requested', ...target, before: null, after: request });
      return success(null);
    },
    agent(toolCallId),
  );
}

/**
 * Audits a resumed call that wrote nothing: `approval.declined` with its reason (AUD-002), or
 * `approval.stale` when the rows the request covered changed since (AUD-003). A call whose approval
 * already has an outcome writes nothing more and refuses with STATE_CHANGED.
 */
export function recordApprovalOutcome(
  tenant: TenantContext,
  permissions: WorkspacePermissions,
  toolCallId: string,
  target: ApprovalTarget,
  outcome:
    | { action: 'approval.declined'; reason: DeclineReason; inputHash: string; comment?: string }
    | { action: 'approval.stale'; inputHash: string; beforeHash: string },
): Promise<ServiceResult<null>> {
  const { action, ...after } = outcome;
  return runWorkspaceWrite(
    tenant,
    permissions,
    async (tx, audit) => {
      if (await approvalOutcomeOf(tx, toolCallId)) return failure('STATE_CHANGED');
      await audit.write({ action, ...target, before: null, after });
      return success(null);
    },
    agent(toolCallId),
  );
}

/** What a resume answers: the open request, or why there is none. */
export type PendingApproval =
  | { status: 'pending'; request: ApprovalRequest; target: ApprovalTarget }
  | { status: 'no_request' | 'already_resolved' };

/**
 * The request a resume answers, read from its `approval.requested` row, so the hashes come from the
 * server and survive a resume on another instance (§7.9, TEN-011). `already_resolved` when the call
 * has an outcome row; `no_request` when no request was audited for it.
 */
export async function findPendingApproval(
  tenant: TenantContext,
  permissions: WorkspacePermissions,
  toolCallId: string,
): Promise<ServiceResult<PendingApproval>> {
  if (!requirePermission(tenant, permissions).ok) return failure('FORBIDDEN');
  return sanitized(tenant.workspaceId, async () => {
    const db = await getWorkspaceDatabase(tenant.workspaceId);
    if (await approvalOutcomeOf(db, toolCallId)) return success({ status: 'already_resolved' });
    const [row] = await db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.approvalToolCallId, toolCallId), eq(auditLog.action, 'approval.requested')),
      )
      .limit(1);
    const request = approvalRequestSchema.safeParse(JSON.parse(row?.afterJson ?? 'null'));
    if (!row || !request.success) return success({ status: 'no_request' });
    const target = { entityType: row.entityType, entityId: row.entityId };
    return success({ status: 'pending', request: request.data, target });
  });
}
