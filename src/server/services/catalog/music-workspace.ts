import type { CatalogFocus, MusicWorkspaceDTO } from '../../../lib/dto/catalog';
import { requirePermission } from '../permissions';
import { loadRightsFacts, missing, scopeOf, summarizeRights } from '../rights/read';
import { failure, type ServiceResult, success } from '../service-result';
import type { TenantContext } from '../tenant-context';
import { pitchSummaryOf, pitchSummaryRead } from './pitch-summary';
import { getSongCatalog } from './read';

/**
 * MusicWorkspaceDTO (§3.3 getMusicWorkspace, §3.4) for the song a composition or recording id
 * names: getSongCatalog's catalog part, the song's RightsSummaryDTO, readiness per live recording
 * (§6.5) and its pitch summary (D-6). A role without catalog, rights and pitch read never opens the
 * database (§6.2); an id with no live song in the tenant's own database is NOT_FOUND (§3.1). Two
 * batches sent together (§1.4): the catalog's, and the rights facts' with the pitch summary.
 */
export async function getMusicWorkspace(
  tenant: TenantContext,
  focus: CatalogFocus,
): Promise<ServiceResult<MusicWorkspaceDTO>> {
  const reads = requirePermission(tenant, { catalog: ['read'], rights: ['read'], pitch: ['read'] });
  if (!reads.ok) return failure('FORBIDDEN');
  const [song, loaded] = await Promise.all([
    getSongCatalog(tenant, focus),
    loadRightsFacts(
      tenant.workspaceId,
      (database) => scopeOf(database, focus),
      (database, ids) => [pitchSummaryRead(database, ids)],
    ),
  ]);
  // Two batches can see different commits: the song must be live in both.
  if (!song.ok) return song;
  if (missing(focus, loaded)) return failure('NOT_FOUND');
  const { summary, results } = summarizeRights(loaded);
  const readiness = loaded.recordings.map(({ take }, index) => {
    const { oneStopReady, syncReady, issues } = results[index];
    return { recordingId: take.id, oneStopReady, syncReady, issues };
  });
  return success({
    ...song.value,
    rights: summary,
    readiness,
    pitchSummary: pitchSummaryOf(loaded.extra[0]),
    importedReportTemplateId: null,
  });
}
