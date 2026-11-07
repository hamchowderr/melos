import { eq } from 'drizzle-orm';
import { ulid } from 'ulid';
import {
  isWorkspaceType,
  readWorkspaceType,
  type WorkspaceType,
} from '../../../lib/workspace-type';
import { controlDb } from '../../db/client';
import { organization } from '../../db/schema/auth';
import { controlAuditLog } from '../../db/schema/control';
import { controlIntegrityGuard as guard } from '../integrity-guard';
import { requirePermission } from '../permissions';
import { failure, type ServiceResult, success } from '../service-result';
import type { TenantContext } from '../tenant-context';

/**
 * ONB-002: sets the workspace type in ctl `organization.metadata` for owners and admins
 * (organization:update) and appends `workspace.type_changed` in the same transaction. Setting the
 * stored type again writes nothing. Only the checklist and start page read the type.
 */
export async function setWorkspaceType(
  tenant: TenantContext,
  workspaceType: unknown,
): Promise<ServiceResult<{ workspaceType: WorkspaceType }>> {
  if (!requirePermission(tenant, { organization: ['update'] }).ok) return failure('FORBIDDEN');
  if (!isWorkspaceType(workspaceType))
    return failure({ code: 'VALIDATION', field: 'workspaceType', reason: 'enum' });
  return controlDb.transaction(async (tx) => {
    const where = eq(organization.id, tenant.organizationId);
    const [row] = await tx
      .select({ metadata: organization.metadata })
      .from(organization)
      .where(where);
    if (!row) return failure('NOT_FOUND');
    const stored = row.metadata ? readWorkspaceType(row.metadata) : null;
    if (stored === workspaceType) return success({ workspaceType });
    await guard.update(tx, organization, { metadata: JSON.stringify({ workspaceType }) }, where);
    await guard.insert(tx, controlAuditLog, [
      {
        id: `cad_${ulid()}`,
        actorUserId: tenant.userId,
        organizationId: tenant.organizationId,
        action: 'workspace.type_changed',
        targetType: 'organization',
        targetId: tenant.organizationId,
        beforeJson: JSON.stringify({ workspaceType: stored }),
        afterJson: JSON.stringify({ workspaceType }),
        occurredAt: new Date().toISOString(),
      },
    ]);
    return success({ workspaceType });
  });
}

/** ONB-006: the active workspace's type from ctl `organization.metadata`. */
export async function getWorkspaceType(
  tenant: Pick<TenantContext, 'organizationId'>,
): Promise<WorkspaceType> {
  const [row] = await controlDb
    .select({ metadata: organization.metadata })
    .from(organization)
    .where(eq(organization.id, tenant.organizationId));
  return readWorkspaceType(row?.metadata);
}
