import type { WorkspacePermissions } from '../../lib/auth/permissions';
import { type Actor, type AuditWriter, createAuditWriter } from './audit-writer';
import { IntegrityError } from './integrity-guard';
import { requirePermission } from './permissions';
import { failure, type ServiceError, type ServiceResult } from './service-result';
import type { TenantContext } from './tenant-context';
import { getWorkspaceDatabase, sanitized, type WorkspaceDatabase } from './workspace-connections';

/** The drizzle transaction a workspace write runs in, over the generated workspace tables. */
export type WorkspaceTransaction = Parameters<Parameters<WorkspaceDatabase['transaction']>[0]>[0];

/** The body of a write: its result, or a refusal that undoes everything it wrote. */
export type WorkspaceWrite<T> = (
  tx: WorkspaceTransaction,
  audit: AuditWriter,
) => Promise<ServiceResult<T>>;

/** Carries a refusal the body returned out of the transaction, so the transaction rolls back. */
class Refusal extends Error {
  constructor(readonly error: ServiceError) {
    super(error.code);
  }
}

/**
 * Every workspace mutation (AUTH-004, AUD-001, DAT-001). A role without `permissions` gets FORBIDDEN
 * before the database opens (§6.2). Otherwise `core` runs with an AuditWriter in one write
 * transaction (drizzle's libSQL default, `BEGIN IMMEDIATE`) on the tenant's own database, which
 * commits only when `core` succeeds. Anything else rolls it all back, audit rows included: a refusal
 * `core` returns comes back as it is, an IntegrityError as its code and counts, and any other error
 * throws WorkspaceConnectionError with its name and code, never its message (§7.2). `origin` names
 * an agent run or import acting for the tenant's user.
 */
export async function runWorkspaceWrite<T>(
  tenant: TenantContext,
  permissions: WorkspacePermissions,
  core: WorkspaceWrite<T>,
  origin: Omit<Actor, 'userId'> = { type: 'user' },
): Promise<ServiceResult<T>> {
  if (!requirePermission(tenant, permissions).ok) return failure('FORBIDDEN');
  const actor = { ...origin, userId: tenant.userId };
  return sanitized(tenant.workspaceId, async () => {
    const database = await getWorkspaceDatabase(tenant.workspaceId);
    try {
      return await database.transaction(async (tx) => {
        const result = await core(tx, createAuditWriter(tx, actor, tenant.requestId));
        if (!result.ok) throw new Refusal(result.error);
        return result;
      });
    } catch (error) {
      if (error instanceof Refusal) return failure(error.error);
      if (error instanceof IntegrityError)
        return failure({ code: error.code, counts: error.counts });
      throw error;
    }
  });
}
