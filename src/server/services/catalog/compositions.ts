import { asc, isNull } from 'drizzle-orm';
import type { CompositionDuplicate } from '../../../lib/dto/catalog';
import { normalizeIswc } from '../../../lib/identifiers';
import { compositions } from '../../db/schema/workspace.generated';
import { requirePermission } from '../permissions';
import { failure, type ServiceResult, success } from '../service-result';
import type { TenantContext } from '../tenant-context';
import { getWorkspaceDatabase, sanitized } from '../workspace-connections';
import { normalizeTitle } from './read';

/**
 * Live compositions whose title normalizes (normalizeTitle, §3.5) to the same text as `title`, or
 * that hold the ISWC `iswc` normalizes to: the §3.3 createComposition approval trigger (§6.15) and
 * the song form's warning. An ISWC normalizeIswc refuses matches nothing, since createComposition
 * refuses it too. catalog:read (§6.2); a refused role never opens the database. One query.
 */
export async function findCompositionDuplicates(
  tenant: TenantContext,
  { title, iswc }: { title: string; iswc?: string | null },
): Promise<ServiceResult<CompositionDuplicate[]>> {
  if (!requirePermission(tenant, { catalog: ['read'] }).ok) return failure('FORBIDDEN');
  const normalized = iswc ? normalizeIswc(iswc) : undefined;
  const sameIswc = normalized?.ok ? normalized.value : undefined;
  const rows = await sanitized(tenant.workspaceId, async () => {
    const database = await getWorkspaceDatabase(tenant.workspaceId);
    const { id: compositionId, title, iswc } = compositions;
    const live = isNull(compositions.deletedAt);
    return database
      .select({ compositionId, title, iswc })
      .from(compositions)
      .where(live)
      .orderBy(asc(compositionId));
  });
  const sameTitle = normalizeTitle(title);
  return success(
    rows.flatMap((row) => {
      const matchedOn = [
        ...(normalizeTitle(row.title) === sameTitle ? (['title'] as const) : []),
        ...(row.iswc !== null && row.iswc === sameIswc ? (['iswc'] as const) : []),
      ];
      return matchedOn.length ? [{ ...row, matchedOn }] : [];
    }),
  );
}
