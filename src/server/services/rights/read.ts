import { and, asc, eq, inArray, isNotNull, isNull, or, type SQL, sql } from 'drizzle-orm';
import type { CatalogFocus } from '../../../lib/dto/catalog';
import type { RightsSummaryDTO } from '../../../lib/dto/rights';
import {
  compositionContributors,
  compositions,
  licensingContacts,
  masterInterests,
  parties,
  publishingInterests,
  recordings,
  workspaceSelfParties,
} from '../../db/schema/workspace.generated';
import { requirePermission } from '../permissions';
import { failure, type ServiceResult, success } from '../service-result';
import type { TenantContext } from '../tenant-context';
import { getWorkspaceDatabase, sanitized, type WorkspaceDatabase } from '../workspace-connections';
import { evaluateRecordingReadiness } from './readiness';

/** Conditions on `compositions` and `recordings` for the rows a read covers; none covers all. */
type Scope = { composition?: SQL; recording?: SQL };

/** rights:read for the role resolved for this request (§6.2); a comma role fails closed (P-30). */
const canRead = (tenant: TenantContext) => requirePermission(tenant, { rights: ['read'] }).ok;

/** A composition and its recordings; a recording id covers its composition and all its recordings. */
function scopeOf(database: WorkspaceDatabase, { entityType, entityId }: CatalogFocus): Scope {
  if (entityType === 'composition') {
    const recording = eq(recordings.compositionId, entityId);
    return { composition: eq(compositions.id, entityId), recording };
  }
  const named = and(eq(recordings.id, entityId), isNull(recordings.deletedAt));
  const owner = database.select({ id: recordings.compositionId }).from(recordings).where(named);
  const recording = or(inArray(recordings.compositionId, owner), eq(recordings.id, entityId));
  return { composition: inArray(compositions.id, owner), recording };
}

/** RightsHolderDTO columns of an interest row joined to its party; `isSelf` checks `side`. */
const holderOf = (interest: typeof publishingInterests | typeof masterInterests, side: string) => ({
  ...{ interestId: interest.id, partyId: parties.id, displayName: parties.displayName },
  shareBp: interest.shareBp,
  isSelf:
    sql`${parties.id} in (select party_id from workspace_self_parties where side = ${side})`.mapWith(
      Boolean,
    ),
  representationAttested: isNotNull(interest.representationAttestedAt).mapWith(Boolean),
  agreementId: interest.agreementId,
});

/**
 * Reads a scope's live rights rows in one libSQL batch (§1.4): writer shares with roles, publishing
 * per territory and masters per recording with holders and attestation, totals from the §4.3 views,
 * self parties, explicit licensing contacts and primary links. Builds the §6.5 facts per recording,
 * with one publishing entry per territory; a recording whose composition is not live gets none.
 */
async function loadRightsFacts(workspaceId: string, scopeFor: (db: WorkspaceDatabase) => Scope) {
  const rows = await sanitized(workspaceId, async () => {
    const database = await getWorkspaceDatabase(workspaceId);
    const scope = scopeFor(database);
    const liveSongs = and(isNull(compositions.deletedAt), scope.composition);
    const liveTakes = and(isNull(recordings.deletedAt), scope.recording);
    const songIds = database.select({ id: compositions.id }).from(compositions).where(liveSongs);
    const takeIds = database.select({ id: recordings.id }).from(recordings).where(liveTakes);
    // Correlated subqueries name the outer table: drizzle leaves a single-table select unqualified.
    return database.batch([
      database
        .select({
          ...{ id: compositions.id, iswc: compositions.iswc },
          writerTotalBp: sql<number>`(select t.writer_total_bp from composition_writer_totals t where t.composition_id = "compositions"."id")`,
        })
        .from(compositions)
        .where(liveSongs),
      database
        .select({
          ...{
            id: recordings.id,
            title: recordings.title,
            compositionId: recordings.compositionId,
          },
          isrc: recordings.isrc,
          masterTotalBp: sql<number>`(select t.master_total_bp from recording_master_totals t where t.recording_id = "recordings"."id")`,
          hasPrimaryLink: sql`exists (select 1 from recording_links l where l.recording_id = "recordings"."id" and l.is_primary = 1)`,
        })
        .from(recordings)
        .where(liveTakes)
        .orderBy(asc(recordings.title), asc(recordings.versionTitle), asc(recordings.id)),
      database
        .select({
          compositionId: compositionContributors.compositionId,
          writer: {
            ...{ contributorId: compositionContributors.id, partyId: parties.id },
            displayName: parties.displayName,
            roles: sql<string>`(select json_group_array(r.role) from composition_contributor_roles r where r.contributor_id = "composition_contributors"."id")`,
            shareBp: compositionContributors.writerShareBp,
          },
        })
        .from(compositionContributors)
        .innerJoin(parties, eq(parties.id, compositionContributors.partyId))
        .where(inArray(compositionContributors.compositionId, songIds))
        .orderBy(asc(parties.displayName), asc(compositionContributors.id)),
      database
        .select({
          compositionId: publishingInterests.compositionId,
          territory: publishingInterests.territory,
          totalBp: sql<number>`(select t.publishing_total_bp from composition_publishing_totals t where t.composition_id = "publishing_interests"."composition_id" and t.territory = "publishing_interests"."territory")`,
          holder: holderOf(publishingInterests, 'publishing'),
        })
        .from(publishingInterests)
        .innerJoin(parties, eq(parties.id, publishingInterests.publisherPartyId))
        .where(inArray(publishingInterests.compositionId, songIds))
        .orderBy(
          asc(publishingInterests.territory),
          asc(parties.displayName),
          asc(publishingInterests.id),
        ),
      database
        .select({
          recordingId: masterInterests.recordingId,
          holder: holderOf(masterInterests, 'master'),
        })
        .from(masterInterests)
        .innerJoin(parties, eq(parties.id, masterInterests.ownerPartyId))
        .where(inArray(masterInterests.recordingId, takeIds))
        .orderBy(asc(parties.displayName), asc(masterInterests.id)),
      database
        .select({
          side: workspaceSelfParties.side,
          partyId: parties.id,
          displayName: parties.displayName,
        })
        .from(workspaceSelfParties)
        .innerJoin(parties, eq(parties.id, workspaceSelfParties.partyId)),
      database
        .select({
          ...{
            recordingId: licensingContacts.recordingId,
            compositionId: licensingContacts.compositionId,
          },
          ...{ partyId: parties.id, displayName: parties.displayName },
        })
        .from(licensingContacts)
        .innerJoin(parties, eq(parties.id, licensingContacts.partyId))
        .where(
          or(
            inArray(licensingContacts.recordingId, takeIds),
            inArray(licensingContacts.compositionId, songIds),
          ),
        )
        .orderBy(asc(parties.id)),
    ]);
  });
  // Only the database work is sanitized, so a bug in the mapping throws as itself.
  const [songs, takes, writers, publishing, masters, selves, contacts] = rows;
  const selfOf = (side: string) => selves.find((party) => party.side === side) ?? null;
  const selfParties = { publishing: selfOf('publishing'), master: selfOf('master') };
  const writersOf = Map.groupBy(writers, (row) => row.compositionId);
  const publishingOf = Map.groupBy(publishing, (row) => row.compositionId);
  const mastersOf = Map.groupBy(masters, (row) => row.recordingId);
  const songRights = songs.map(({ id, iswc, writerTotalBp }) => {
    const sets = Map.groupBy(publishingOf.get(id) ?? [], (row) => row.territory);
    const song = {
      ...{ id, iswc, writerTotalBp },
      writers: (writersOf.get(id) ?? []).map(({ writer }) => ({
        ...writer,
        roles: (JSON.parse(writer.roles) as string[]).sort(),
      })),
      // One entry per territory, in territory order, as the evaluator needs.
      publishing: [...sets].map(([territory, set]) => ({
        ...{ territory, totalBp: set[0].totalBp, holders: set.map(({ holder }) => holder) },
      })),
    };
    return [id, song] as const;
  });
  const rights = new Map(songRights);
  const recordingRights = takes.map((take) => {
    const composition = rights.get(take.compositionId ?? '') ?? null;
    const holders = (mastersOf.get(take.id) ?? []).map(({ holder }) => holder);
    const facts = {
      ...{ recordingId: take.id, isrc: take.isrc, hasPrimaryLink: Boolean(take.hasPrimaryLink) },
      ...{ selfParties, composition, masters: holders },
      licensingContacts: contacts.filter(
        (contact) => contact.recordingId === take.id || contact.compositionId === composition?.id,
      ),
    };
    const master = { recordingId: take.id, totalBp: take.masterTotalBp, holders };
    return { take, facts, master, orphaned: take.compositionId !== null && !composition };
  });
  return { compositions: rights, recordings: recordingRights, contacts };
}

/** No live row for the id in the tenant's own database, or a recording of a deleted composition. */
function missing(
  { entityType, entityId }: CatalogFocus,
  loaded: Awaited<ReturnType<typeof loadRightsFacts>>,
) {
  if (entityType === 'composition') return !loaded.compositions.has(entityId);
  const focused = loaded.recordings.find(({ take }) => take.id === entityId);
  return !focused || focused.orphaned;
}

/**
 * RightsSummaryDTO (§3.4) for the song a composition or recording id names; a recording resolves to
 * its composition, and one without a composition has no writer or publishing side. Licensing
 * contacts merge per song: the explicit contacts on the composition or any live recording of it;
 * with none, the implicit contact only when every live recording has it (P-28). One batch.
 */
export async function getRightsSummary(
  tenant: TenantContext,
  focus: CatalogFocus,
): Promise<ServiceResult<RightsSummaryDTO>> {
  if (!canRead(tenant)) return failure('FORBIDDEN');
  const loaded = await loadRightsFacts(tenant.workspaceId, (db) => scopeOf(db, focus));
  if (missing(focus, loaded)) return failure('NOT_FOUND');
  const [song] = loaded.compositions.values();
  const results = loaded.recordings.map(({ facts }) => evaluateRecordingReadiness(facts));
  const named = new Map(loaded.contacts.map(({ partyId, displayName }) => [partyId, displayName]));
  const explicit = [...named].map(([partyId, displayName]) => ({ partyId, displayName }));
  const implicit = results.length > 0 && results.every((r) => r.licensingContacts[0]?.implicit);
  return success({
    compositionId: song?.id ?? null,
    writers: song?.writers ?? [],
    writerTotalBp: song?.writerTotalBp ?? 0,
    publishing: song?.publishing ?? [],
    masters: loaded.recordings.map(({ master }) => master),
    licensingContacts: explicit.length
      ? explicit.map((party) => ({ ...party, implicit: false }))
      : (implicit && results[0].licensingContacts) || [],
    issues: results.flatMap(({ issues }) => issues),
  });
}
