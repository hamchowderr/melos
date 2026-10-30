import { and, eq, isNull } from 'drizzle-orm';
import type { WorkspacePermissions } from '../../../lib/auth/permissions';
import type { MusicWorkspaceDTO, SongInput } from '../../../lib/dto/catalog';
import { compositions, recordings } from '../../db/schema/workspace.generated';
import { workspaceIntegrityGuard as guard } from '../integrity-guard';
import { requirePermission } from '../permissions';
import { failure, type ServiceResult, success } from '../service-result';
import type { TenantContext } from '../tenant-context';
import { runWorkspaceWrite } from '../workspace-write';
import { insertComposition, invalidComposition } from './compositions';
import { getMusicWorkspace } from './music-workspace';
import { insertRecording, invalidRecording } from './recordings';
import { reindexSong } from './search-index';

const CREATE: WorkspacePermissions = { catalog: ['create'] };
const DELETE: WorkspacePermissions = { catalog: ['delete'] };

/**
 * Creates a song from /catalog (CAT-001, D-10): a composition and its first recording, with the
 * same title, in one audited write, so a refusal on either side stores neither. catalog:create
 * (§6.2) and VALIDATION for both come first, before the database opens; then INVALID_ISWC,
 * INVALID_ISRC or CONFLICT. Audits composition.create and recording.create, then returns the
 * song's MusicWorkspaceDTO.
 */
export async function createSong(
  tenant: TenantContext,
  { isrc, ...composition }: SongInput,
): Promise<ServiceResult<MusicWorkspaceDTO>> {
  if (!requirePermission(tenant, CREATE).ok) return failure('FORBIDDEN');
  const recording = { title: composition.title, isrc };
  const refused = invalidComposition(composition) ?? invalidRecording(recording);
  if (refused) return refused;
  const written = await runWorkspaceWrite(tenant, CREATE, async (tx, audit) => {
    const compositionId = await insertComposition(tx, audit, tenant, composition);
    if (!compositionId.ok) return compositionId;
    const recordingId = await insertRecording(tx, audit, tenant, {
      ...recording,
      compositionId: compositionId.value,
    });
    return recordingId.ok ? success(compositionId.value) : recordingId;
  });
  if (!written.ok) return written;
  return getMusicWorkspace(tenant, { entityType: 'composition', entityId: written.value });
}

/**
 * Deletes a song from /catalog (CAT-001): its live recordings, then its composition, soft-deleted
 * in one audited write (§4.2, D-11), so the song leaves the catalog whole or not at all.
 * catalog:delete (§6.2: owners and admins) comes first, before the database opens. A composition
 * with no live row is NOT_FOUND; a recording or composition that something still references, such
 * as a release track, a share or a pitch, is REFERENCED with its counts and nothing is deleted.
 * Audits recording.delete for each recording and composition.delete (D-4).
 */
export async function deleteSong(
  tenant: TenantContext,
  compositionId: string,
): Promise<ServiceResult<{ compositionId: string }>> {
  if (!requirePermission(tenant, DELETE).ok) return failure('FORBIDDEN');
  return runWorkspaceWrite(tenant, DELETE, async (tx, audit) => {
    const song = and(eq(compositions.id, compositionId), isNull(compositions.deletedAt));
    const [composition] = await tx.select().from(compositions).where(song);
    if (!composition) return failure('NOT_FOUND');
    const own = and(eq(recordings.compositionId, compositionId), isNull(recordings.deletedAt));
    const parts = [
      ...(await tx.select().from(recordings).where(own)).map((row) => ['recording', row] as const),
      ['composition', composition] as const,
    ];
    for (const [entityType, before] of parts) {
      const table = entityType === 'recording' ? recordings : compositions;
      await guard.softDelete(tx, table, eq(table.id, before.id), tenant.userId);
      const [after] = await tx.select().from(table).where(eq(table.id, before.id));
      await audit.write({
        ...{ action: `${entityType}.delete`, entityType, entityId: before.id },
        ...{ before, after },
      });
    }
    await reindexSong(tx, compositionId);
    return success({ compositionId });
  });
}
