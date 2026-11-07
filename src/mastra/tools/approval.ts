import {
  type ApprovalDecision,
  type ApprovalKind,
  type ApprovalRequest,
  type ApprovalRow,
  approvalDecisionSchema,
} from '../../lib/agent/approval';
import type { ToolResult } from '../../lib/agent/tool-result';
import type { WorkspacePermissions } from '../../lib/auth/permissions';
import {
  type ApprovalTarget,
  findPendingApproval,
  inputHashOf,
  recordApprovalOutcome,
  recordApprovalRequest,
} from '../../server/services/approvals';
import { requirePermission } from '../../server/services/permissions';
import type { ServiceResult } from '../../server/services/service-result';
import type { TenantContext } from '../../server/services/tenant-context';
import type { WriteOrigin } from '../../server/services/workspace-write';
import { readTenantContext } from '../request-context';

/** What a write shows and re-checks before it may run (§7.4 step 1), from a read-only preview. */
export type ApprovalPreview = {
  target: ApprovalTarget;
  summary: string;
  before: ApprovalRow[];
  after: ApprovalRow[];
  beforeHash: string;
  /** sendMessage only: the content the approval binds (§7.4). */
  contentHash?: string;
  reasons?: string[];
};

/** The parts of the Mastra tool context an approval reads (SRC-042). */
type ApprovalContext =
  | {
      requestContext?: { get(key: string): unknown };
      agent?: {
        toolCallId: string;
        suspend: (payload: ApprovalRequest) => Promise<void>;
        resumeData?: unknown;
      };
    }
  | undefined;

export type ApprovedWrite<I, T> = {
  toolName: string;
  kind: ApprovalKind;
  permissions: WorkspacePermissions;
  preview: (tenant: TenantContext, input: I) => Promise<ServiceResult<ApprovalPreview>>;
  apply: (
    tenant: TenantContext,
    input: I,
    expectedBeforeHash: string,
    origin: WriteOrigin,
    request: ApprovalRequest,
  ) => Promise<ServiceResult<T>>;
};

const refusal = (code: string, details: Record<string, unknown> = {}): ToolResult<never> => ({
  status: 'error',
  error: { code, ...details },
});
const fromService = <T>(result: ServiceResult<T>): ToolResult<T> =>
  result.ok
    ? { status: 'ok', value: result.value }
    : { status: 'error', error: { ...result.error } };

/**
 * The execute of a tool that always asks first (§6.3, §7.4, ADR-014, ADR-015). The first call
 * previews without writing, audits `approval.requested` and suspends with the ApprovalRequest. The
 * resume reads the request back from `audit_log`, never from the client: a decision for other input
 * or a decline writes nothing and audits `approval.declined` (DECLINED); an approval runs the write
 * with the request's `beforeHash` and `approval.granted` in its transaction, or audits
 * `approval.stale` and returns STATE_CHANGED when the rows changed since (AUD-002, AUD-003).
 */
export function approvedWrite<I, T>(write: ApprovedWrite<I, T>) {
  return async (input: I, context: ApprovalContext): Promise<ToolResult<T>> => {
    let tenant: TenantContext;
    try {
      tenant = readTenantContext(context?.requestContext);
    } catch {
      return refusal('NO_TENANT');
    }
    const agent = context?.agent;
    if (!agent?.toolCallId) return refusal('APPROVAL_UNAVAILABLE');
    const { toolName, kind, permissions } = write;
    if (!requirePermission(tenant, permissions).ok) return refusal('FORBIDDEN');
    const inputHash = inputHashOf(toolName, input);
    const callId = agent.toolCallId;

    if (agent.resumeData === undefined) {
      const preview = await write.preview(tenant, input);
      if (!preview.ok) return fromService(preview);
      const { target, reasons = [], ...shown } = preview.value;
      const request = { kind, toolName, inputHash, reasons, ...shown };
      const recorded = await recordApprovalRequest(tenant, permissions, callId, target, request);
      if (!recorded.ok) return fromService(recorded);
      // Mastra requires returning right after suspend (SRC-042); the resume runs this again.
      await agent.suspend(request);
      return undefined as never;
    }

    const pending = await findPendingApproval(tenant, permissions, callId);
    if (!pending.ok) return fromService(pending);
    if (pending.value.status !== 'pending')
      return refusal('DECLINED', { reason: pending.value.status });
    const { request, target } = pending.value;
    const decision = approvalDecisionSchema.safeParse(agent.resumeData);
    // A malformed answer counts as a decline for no input, so it is audited as input_mismatch.
    const answer: ApprovalDecision = decision.success
      ? decision.data
      : { approved: false, inputHash: '' };
    const declined = async (reason: 'declined' | 'input_mismatch') => {
      const { comment } = answer;
      const outcome = { action: 'approval.declined' as const, reason, inputHash: answer.inputHash };
      const recorded = await recordApprovalOutcome(tenant, permissions, callId, target, {
        ...outcome,
        ...(comment ? { comment } : {}),
      });
      return recorded.ok
        ? refusal('DECLINED', { reason })
        : refusal(recorded.error.code, recorded.error);
    };
    if (answer.inputHash !== request.inputHash || inputHash !== request.inputHash)
      return declined('input_mismatch');
    if (!answer.approved) return declined('declined');

    const granted = { ...target, after: { inputHash, beforeHash: request.beforeHash } };
    const origin = { type: 'agent' as const, approvalToolCallId: callId, granted };
    const applied = await write.apply(tenant, input, request.beforeHash, origin, request);
    if (!applied.ok && applied.error.code === 'STATE_CHANGED') {
      await recordApprovalOutcome(tenant, permissions, callId, target, {
        ...{ action: 'approval.stale', inputHash, beforeHash: request.beforeHash },
      });
    }
    return fromService(applied);
  };
}
