import { and, eq, isNull } from 'drizzle-orm';
import type { WorkspacePermissions } from '../../../lib/auth/permissions';
import { compositions, recordings, releases } from '../../db/schema/workspace.generated';
import type { AuditAction } from '../audit-writer';
import { workspaceIntegrityGuard as guard } from '../integrity-guard';
import { requirePermission } from '../permissions';
import { failure, type ServiceResult, success } from '../service-result';
import type { TenantContext } from '../tenant-context';
import { runWorkspaceWrite, type WorkspaceTransaction } from '../workspace-write';
import { reindexRecording, reindexSong } from './search-index';

const DELETE: WorkspacePermissions = { catalog: ['delete'] };

type Catalog = typeof compositions | typeof recordings | typeof releases;
type Entity = 'composition' | 'recording' | 'release';

/**
 * Soft-deletes one live catalog row (§4.2, D-11) in one audited write. catalog:delete (§6.2: owners
 * and admins; the UI asks for explicit confirmation) comes first, before the database opens. A row
 * with no live match is NOT_FOUND; one that a live row still references through a RESTRICT rule is
 * REFERENCED with the counts per table (§4.4 rule 2), and nothing is written. `after` runs in the
 * transaction once the row is deleted, to reindex what it leaves behind. Audits `<entity>.delete`
 * with the row before and after (D-4).
 */
async function softDelete(
  tenant: TenantContext,
  table: Catalog,
  entityType: Entity,
  id: string,
  after: (tx: WorkspaceTransaction, row: Record<string, unknown>) => Promise<void> = async () => {},
): Promise<ServiceResult<{ entityType: Entity; entityId: string }>> {
  if (!requirePermission(tenant, DELETE).ok) return failure('FORBIDDEN');
  return runWorkspaceWrite(tenant, DELETE, async (tx, audit) => {
    const [before] = await tx
      .select()
      .from(table)
      .where(and(eq(table.id, id), isNull(table.deletedAt)));
    if (!before) return failure('NOT_FOUND');
    await guard.softDelete(tx, table, eq(table.id, id), tenant.userId);
    await after(tx, before);
    const [deleted] = await tx.select().from(table).where(eq(table.id, id));
    await audit.write({
      ...{ action: `${entityType}.delete` as AuditAction, entityType, entityId: id },
      ...{ before, after: deleted ?? null },
    });
    return success({ entityType, entityId: id });
  });
}

/**
 * Soft-deletes a song's composition and removes its catalog_search rows (CAT-001). A composition
 * that live recordings, contributors, publishing interests or pitch items hold is REFERENCED.
 */
export const deleteComposition = (tenant: TenantContext, compositionId: string) =>
  softDelete(tenant, compositions, 'composition', compositionId, (tx) =>
    reindexSong(tx, compositionId),
  );

/**
 * Soft-deletes a recording and reindexes its song, or removes its own catalog_search row when it
 * has no composition. A recording on a release, or with master interests or pitch items, is
 * REFERENCED.
 */
export const deleteRecording = (tenant: TenantContext, recordingId: string) =>
  softDelete(tenant, recordings, 'recording', recordingId, async (tx, row) => {
    const compositionId = row.compositionId as string | null;
    if (compositionId) await reindexSong(tx, compositionId);
    else await reindexRecording(tx, recordingId);
  });

/** Soft-deletes a release; its tracks stay with it, so its recordings stay where they are. */
export const deleteRelease = (tenant: TenantContext, releaseId: string) =>
  softDelete(tenant, releases, 'release', releaseId);
