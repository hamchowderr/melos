import { eq } from 'drizzle-orm';
import { ulid } from 'ulid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ApprovalRequest } from '../../src/lib/agent/approval';
import type { WorkspacePermissions } from '../../src/lib/auth/permissions';
import { auditLog, compositions } from '../../src/server/db/schema/workspace.generated';
import { workspaceIntegrityGuard as guard } from '../../src/server/services/integrity-guard';
import { failure, success } from '../../src/server/services/service-result';
import type { TenantContext } from '../../src/server/services/tenant-context';
import type { WorkspaceWrite } from '../../src/server/services/workspace-write';
import { prepareWorkspaceServices, withRole } from './workspace-service';

// melos-qlw.1: the approval audit rows of §7.4 (AUD-002, AUD-003) at the service level.

const AT = '2026-09-14T18:00:00.000Z';
const RIGHTS: WorkspacePermissions = { rights: ['update'] };
let services: Awaited<ReturnType<typeof prepareWorkspaceServices>>;
let approvals: typeof import('../../src/server/services/approvals');
let write: typeof import('../../src/server/services/workspace-write');
let member: TenantContext;

const hash = (digit: string) => digit.repeat(64);
const target = { entityType: 'composition', entityId: 'cmp_TARGET' };
const request: ApprovalRequest = {
  ...{ kind: 'rights_change', toolName: 'updateWriterShares', summary: 'Change the split.' },
  ...{ before: [{ id: 'pty_A', label: 'A', shareBp: 10000 }], after: [] },
  ...{ inputHash: hash('a'), beforeHash: hash('b'), reasons: [] },
};
/** The approval rows of one tool call, oldest first. */
const rowsOf = async (toolCallId: string) =>
  (await services.connections.getWorkspaceDatabase(member.workspaceId))
    .select()
    .from(auditLog)
    .where(eq(auditLog.approvalToolCallId, toolCallId))
    .orderBy(auditLog.id);
const create =
  (id: string, refuse = false): WorkspaceWrite<string> =>
  async (tx, audit) => {
    await guard.insert(tx, compositions, [{ id, title: id, createdAt: AT, updatedAt: AT }]);
    await audit.write({
      action: 'composition.create',
      entityType: 'composition',
      entityId: id,
      before: null,
      after: { id },
    });
    return refuse ? failure('NOT_FOUND') : success(id);
  };
const grant = (toolCallId: string) => ({
  ...{ type: 'agent' as const, approvalToolCallId: toolCallId },
  granted: { ...target, after: { inputHash: hash('a'), beforeHash: hash('b') } },
});

beforeAll(async () => {
  services = await prepareWorkspaceServices('approvals');
  approvals = await import('../../src/server/services/approvals');
  write = await import('../../src/server/services/workspace-write');
  member = await services.provision('member');
});
afterAll(() => services?.close());

describe('melos-qlw.1: approval audit rows (§7.4, AUD-002, AUD-003)', () => {
  it('inputHash is SHA-256 of the canonical tool name and input, whatever the key order', () => {
    const one = approvals.inputHashOf('updateWriterShares', { b: 1, a: [2, { d: 3, c: 4 }] });
    const two = approvals.inputHashOf('updateWriterShares', { a: [2, { c: 4, d: 3 }], b: 1 });
    expect(one).toMatch(/^[0-9a-f]{64}$/);
    expect(one).toBe(two);
    expect(approvals.inputHashOf('updateMasterShares', { a: [2, { c: 4, d: 3 }], b: 1 })).not.toBe(
      one,
    );
  });

  it('records approval.requested with the tool call id; a viewer is FORBIDDEN and writes nothing', async () => {
    const call = `call_${ulid()}`;
    const viewer = withRole(member, 'viewer');
    expect(await approvals.recordApprovalRequest(viewer, RIGHTS, call, target, request)).toEqual(
      failure('FORBIDDEN'),
    );
    expect(await rowsOf(call)).toEqual([]);
    expect(await approvals.recordApprovalRequest(member, RIGHTS, call, target, request)).toEqual(
      success(null),
    );
    const [row] = await rowsOf(call);
    expect(row).toMatchObject({
      action: 'approval.requested',
      actorType: 'agent',
      actorUserId: member.userId,
      ...target,
    });
    expect(JSON.parse(row.afterJson ?? '')).toEqual(request);
  });

  it('finds the pending request, and none once an outcome is audited', async () => {
    const call = `call_${ulid()}`;
    expect(await approvals.findPendingApproval(member, RIGHTS, call)).toEqual(
      success({ status: 'no_request' }),
    );
    await approvals.recordApprovalRequest(member, RIGHTS, call, target, request);
    expect(await approvals.findPendingApproval(member, RIGHTS, call)).toEqual(
      success({ status: 'pending', request, target }),
    );
    const declined = {
      action: 'approval.declined' as const,
      reason: 'declined' as const,
      inputHash: hash('a'),
    };
    expect(await approvals.recordApprovalOutcome(member, RIGHTS, call, target, declined)).toEqual(
      success(null),
    );
    expect(await approvals.findPendingApproval(member, RIGHTS, call)).toEqual(
      success({ status: 'already_resolved' }),
    );
    // A second outcome for the same call refuses and writes nothing.
    const stale = {
      action: 'approval.stale' as const,
      inputHash: hash('a'),
      beforeHash: hash('b'),
    };
    expect(await approvals.recordApprovalOutcome(member, RIGHTS, call, target, stale)).toEqual(
      failure('STATE_CHANGED'),
    );
    expect((await rowsOf(call)).map(({ action }) => action)).toEqual([
      'approval.requested',
      'approval.declined',
    ]);
  });

  it('approval.granted commits with the mutation, rolls back with it, and only once per call', async () => {
    const call = `call_${ulid()}`;
    await approvals.recordApprovalRequest(member, RIGHTS, call, target, request);
    const refused = await write.runWorkspaceWrite(
      member,
      RIGHTS,
      create(`cmp_${ulid()}`, true),
      grant(call),
    );
    expect(refused).toEqual(failure('NOT_FOUND'));
    expect((await rowsOf(call)).map(({ action }) => action)).toEqual(['approval.requested']);

    const id = `cmp_${ulid()}`;
    expect(await write.runWorkspaceWrite(member, RIGHTS, create(id), grant(call))).toEqual(
      success(id),
    );
    const rows = await rowsOf(call);
    expect(rows.map(({ action }) => action)).toEqual([
      'approval.requested',
      'composition.create',
      'approval.granted',
    ]);
    expect(rows[2]).toMatchObject({ ...target, beforeJson: null, requestId: member.requestId });

    const core = vi.fn(create(`cmp_${ulid()}`));
    expect(await write.runWorkspaceWrite(member, RIGHTS, core, grant(call))).toEqual(
      failure('STATE_CHANGED'),
    );
    expect(core).not.toHaveBeenCalled();
    expect(await rowsOf(call)).toHaveLength(3);
  });
});
