import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { WorkspacePermissions } from '../../../lib/auth/permissions';
import {
  ARTIST_ROLES,
  type MusicWorkspaceDTO,
  type RecordingArtistInput,
} from '../../../lib/dto/catalog';
import {
  artistAliases,
  parties,
  recordingArtists,
  recordings,
} from '../../db/schema/workspace.generated';
import { workspaceIntegrityGuard as guard } from '../integrity-guard';
import { requirePermission } from '../permissions';
import { planByNaturalKey } from '../rights/shares';
import { failure, type ServiceResult, success } from '../service-result';
import type { TenantContext } from '../tenant-context';
import { runWorkspaceWrite, type WorkspaceTransaction } from '../workspace-write';
import { getMusicWorkspace } from './music-workspace';
import { reindexRecording, reindexSong } from './search-index';

const UPDATE: WorkspacePermissions = { catalog: ['update'] };

const refuse = (reason: string) => failure({ code: 'VALIDATION', field: 'artists', reason });
const keyOf = ({ partyId, role }: { partyId: string; role: string }) => `${partyId}|${role}`;

/** VALIDATION for the first broken credit, before the database opens. */
function invalid(artists: RecordingArtistInput[]): ServiceResult<never> | null {
  if (artists.some(({ role }) => !ARTIST_ROLES.includes(role))) return refuse('unknown_role');
  if (new Set(artists.map(keyOf)).size < artists.length) return refuse('duplicate_artist');
  const order = artists.map(({ billingOrder }) => billingOrder);
  if (order.some((value) => value !== undefined && !(Number.isInteger(value) && value >= 0)))
    return refuse('not_a_whole_number');
  return null;
}

/** A recording's artist set in billing order, read in the write transaction for the audit log. */
const artistsOf = (tx: WorkspaceTransaction, recordingId: string) => {
  const { id, partyId, artistAliasId, role, billingOrder } = recordingArtists;
  return tx
    .select({ id, partyId, artistAliasId, role, billingOrder })
    .from(recordingArtists)
    .where(eq(recordingArtists.recordingId, recordingId))
    .orderBy(asc(billingOrder), asc(role), asc(partyId));
};

/**
 * Replaces a recording's primary and featured artists (CAT-003) in one audited write, upserting on
 * (party, role) so a credit in both sets keeps its id (§4.4). catalog:update (§6.2) and VALIDATION
 * come first, before the database opens. A recording or party with no live row is NOT_FOUND; an
 * alias that is not the credited party's own is VALIDATION. The song is reindexed (G-13) and
 * recording_artists.replace audited with both sets; then returns the song's MusicWorkspaceDTO.
 */
export async function updateRecordingArtists(
  tenant: TenantContext,
  recordingId: string,
  artists: RecordingArtistInput[],
): Promise<ServiceResult<MusicWorkspaceDTO>> {
  if (!requirePermission(tenant, UPDATE).ok) return failure('FORBIDDEN');
  const refused = invalid(artists);
  if (refused) return refused;
  const written = await runWorkspaceWrite(tenant, UPDATE, async (tx, audit) => {
    const live = and(eq(recordings.id, recordingId), isNull(recordings.deletedAt));
    const [recording] = await tx
      .select({ compositionId: recordings.compositionId })
      .from(recordings)
      .where(live);
    if (!recording) return failure('NOT_FOUND');
    const ids = [...new Set(artists.map(({ partyId }) => partyId))];
    const named = ids.length
      ? await tx
          .select({ id: parties.id })
          .from(parties)
          .where(and(inArray(parties.id, ids), isNull(parties.deletedAt)))
      : [];
    if (named.length < ids.length) return failure('NOT_FOUND');
    const aliasIds = artists.flatMap(({ artistAliasId }) => (artistAliasId ? [artistAliasId] : []));
    const owners = new Map(
      (aliasIds.length
        ? await tx
            .select({ id: artistAliases.id, partyId: artistAliases.partyId })
            .from(artistAliases)
            .where(inArray(artistAliases.id, aliasIds))
        : []
      ).map((alias) => [alias.id, alias.partyId]),
    );
    const foreign = ({ partyId, artistAliasId }: RecordingArtistInput) =>
      artistAliasId && owners.get(artistAliasId) !== partyId;
    if (artists.some(foreign)) return refuse('alias_of_other_party');
    const rows = artists.map((artist, index) => ({
      ...{
        partyId: artist.partyId,
        role: artist.role,
        artistAliasId: artist.artistAliasId ?? null,
      },
      billingOrder: artist.billingOrder ?? index,
    }));
    const before = await artistsOf(tx, recordingId);
    const plan = planByNaturalKey(
      before.map((row) => ({ id: row.id, key: keyOf(row) })),
      rows,
      keyOf,
    );
    const held = new Map(before.map((row) => [row.id, row]));
    const same = ({ id, row }: (typeof plan.kept)[number]) =>
      held.get(id)?.artistAliasId === row.artistAliasId &&
      held.get(id)?.billingOrder === row.billingOrder;
    if (!plan.gone.length && !plan.added.length && plan.kept.every(same))
      return success(recordingId);
    if (plan.gone.length)
      await guard.delete(tx, recordingArtists, inArray(recordingArtists.id, plan.gone));
    for (const { id, row } of plan.kept) {
      const { artistAliasId, billingOrder } = row;
      const where = eq(recordingArtists.id, id);
      await guard.update(tx, recordingArtists, { artistAliasId, billingOrder }, where);
    }
    if (plan.added.length)
      await guard.insert(
        tx,
        recordingArtists,
        plan.added.map((row) => ({ id: ulid(), recordingId, ...row })),
      );
    if (recording.compositionId) await reindexSong(tx, recording.compositionId);
    else await reindexRecording(tx, recordingId);
    await audit.write({
      ...{ action: 'recording_artists.replace', entityType: 'recording', entityId: recordingId },
      ...{ before: { artists: before }, after: { artists: await artistsOf(tx, recordingId) } },
    });
    return success(recordingId);
  });
  return written.ok
    ? getMusicWorkspace(tenant, { entityType: 'recording', entityId: written.value })
    : written;
}
