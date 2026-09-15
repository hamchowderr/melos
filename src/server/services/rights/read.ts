import { and, asc, eq, inArray, isNotNull, isNull, or, type SQL, sql } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import type { SQLWrapper } from 'drizzle-orm/sql';
import type { CatalogFocus } from '../../../lib/dto/catalog';
import type { ReadinessReportDTO, RightsSummaryDTO } from '../../../lib/dto/rights';
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
/** Subqueries for the ids of a scope's live compositions and live recordings. */
export type ScopeIds = { songIds: SQLWrapper; takeIds: SQLWrapper };

/** rights:read for the role resolved for this request (§6.2); a comma role fails closed (P-30). */
const canRead = (tenant: TenantContext) => requirePermission(tenant, { rights: ['read'] }).ok;

/**
 * A composition and its recordings; a recording id covers its composition and, for a `song`, all its
 * recordings, otherwise only itself.
 */
export function scopeOf(database: WorkspaceDatabase, focus: CatalogFocus, song = true) {
  const { entityType, entityId } = focus;
  if (entityType === 'composition') {
    const recording = eq(recordings.compositionId, entityId);
    return { composition: eq(compositions.id, entityId), recording };
  }
  const named = and(eq(recordings.id, entityId), isNull(recordings.deletedAt));
  const owner = database.select({ id: recordings.compositionId }).from(recordings).where(named);
  const alone = eq(recordings.id, entityId);
  const recording = song ? or(inArray(recordings.compositionId, owner), alone) : alone;
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
 * `alongside` adds the caller's statements to the same batch; their rows come back as `extra`.
 */
export async function loadRightsFacts<const E extends readonly BatchItem<'sqlite'>[]>(
  workspaceId: string,
  scopeFor: (db: WorkspaceDatabase) => Scope,
  alongside: (db: WorkspaceDatabase, ids: ScopeIds) => E,
) {
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
      ...alongside(database, { songIds, takeIds }),
    ]);
  });
  // Only the database work is sanitized, so a bug in the mapping throws as itself.
  const [songs, takes, writers, publishing, masters, selves, contacts, ...extra] = rows;
  const selfOf = (side: string) => selves.find((party) => party.side === side) ?? null;
  const selfParties = { publishing: selfOf('publishing'), master: selfOf('master') };
  const writersOf = Map.groupBy(writers, (row) => row.compositionId);
  const publishingOf = Map.groupBy(publishing, (row) => row.compositionId);
  const mastersOf = Map.groupBy(masters, (row) => row.recordingId);
  const takeContactsOf = Map.groupBy(contacts, (row) => row.recordingId);
  const songContactsOf = Map.groupBy(contacts, (row) => row.compositionId);
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
      licensingContacts: [
        ...(takeContactsOf.get(take.id) ?? []),
        ...(composition ? (songContactsOf.get(composition.id) ?? []) : []),
      ],
    };
    const master = { recordingId: take.id, totalBp: take.masterTotalBp, holders };
    return { take, facts, master, orphaned: take.compositionId !== null && !composition };
  });
  return { compositions: rights, recordings: recordingRights, contacts, extra };
}

/** No live row for the id in the tenant's own database, or a recording of a deleted composition. */
export function missing(
  { entityType, entityId }: CatalogFocus,
  loaded: Awaited<ReturnType<typeof loadRightsFacts>>,
) {
  if (entityType === 'composition') return !loaded.compositions.has(entityId);
  const focused = loaded.recordings.find(({ take }) => take.id === entityId);
  return !focused || focused.orphaned;
}

/**
 * RightsSummaryDTO (§3.4) for the song a composition or recording id names; a recording resolves to
 * its composition, and one without a composition has no writer or publishing side. One batch.
 */
export async function getRightsSummary(
  tenant: TenantContext,
  focus: CatalogFocus,
): Promise<ServiceResult<RightsSummaryDTO>> {
  if (!canRead(tenant)) return failure('FORBIDDEN');
  const loaded = await loadRightsFacts(
    tenant.workspaceId,
    (db) => scopeOf(db, focus),
    () => [],
  );
  if (missing(focus, loaded)) return failure('NOT_FOUND');
  return success(summarizeRights(loaded).summary);
}

/**
 * A song's RightsSummaryDTO from its loaded facts, with each loaded recording's readiness in load
 * order. Licensing contacts are the union by party of each live recording's own contacts (§3.4).
 */
export function summarizeRights(loaded: Awaited<ReturnType<typeof loadRightsFacts>>) {
  const [song] = loaded.compositions.values();
  const results = loaded.recordings.map(({ facts }) => evaluateRecordingReadiness(facts));
  // With no live recording, the rows that target the composition; a party explicit anywhere stays so.
  const own = results.length
    ? results.flatMap(({ licensingContacts }) => licensingContacts)
    : loaded.contacts.map(({ partyId, displayName }) => ({
        partyId,
        displayName,
        implicit: false,
      }));
  const byParty = new Map<string, (typeof own)[number]>();
  for (const contact of own) {
    if (!contact.implicit || !byParty.has(contact.partyId)) byParty.set(contact.partyId, contact);
  }
  const licensingContacts = [...byParty.values()].sort((a, b) => (a.partyId < b.partyId ? -1 : 1));
  const summary: RightsSummaryDTO = {
    compositionId: song?.id ?? null,
    writers: song?.writers ?? [],
    writerTotalBp: song?.writerTotalBp ?? 0,
    publishing: song?.publishing ?? [],
    masters: loaded.recordings.map(({ master }) => master),
    licensingContacts,
    issues: results.flatMap(({ issues }) => issues),
  };
  return { summary, results };
}

/**
 * ReadinessReportDTO (§3.4) for one live recording, the live recordings of a composition, or every
 * live recording, by title; a recording of a deleted composition is left out, as in listSongs.
 * `onlyNotReady` keeps recordings that are not sync ready, which include every recording that is not
 * one-stop ready; `limit`, an integer from 1 to 200 (otherwise 50), applies after it. One batch.
 */
export async function getReadinessIssues(
  tenant: TenantContext,
  query: {
    recordingId?: string;
    compositionId?: string;
    onlyNotReady?: boolean;
    limit?: number;
  } = {},
): Promise<ServiceResult<ReadinessReportDTO>> {
  if (!canRead(tenant)) return failure('FORBIDDEN');
  const { recordingId, compositionId, onlyNotReady = true, limit: asked } = query;
  // The /rights page calls this directly, so a missing or invalid limit takes the default.
  const valid = asked !== undefined && Number.isInteger(asked) && asked >= 1;
  const limit = valid ? Math.min(asked, 200) : 50;
  const focus: CatalogFocus | null = recordingId
    ? { entityType: 'recording', entityId: recordingId }
    : compositionId
      ? { entityType: 'composition', entityId: compositionId }
      : null;
  const scope = (db: WorkspaceDatabase): Scope => (focus ? scopeOf(db, focus, false) : {});
  const loaded = await loadRightsFacts(tenant.workspaceId, scope, () => []);
  if (focus && missing(focus, loaded)) return failure('NOT_FOUND');
  const live = loaded.recordings.filter(({ orphaned }) => !orphaned);
  const report = live.map(({ take, facts }) => {
    const { oneStopReady, syncReady, issues } = evaluateRecordingReadiness(facts);
    const ids = { recordingId: take.id, compositionId: facts.composition?.id ?? null };
    return { ...ids, title: take.title, oneStopReady, syncReady, issues };
  });
  const listed = report.filter(({ syncReady }) => !onlyNotReady || !syncReady);
  return success({ generatedAt: new Date().toISOString(), recordings: listed.slice(0, limit) });
}
