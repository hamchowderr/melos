import { and, asc, type Column, desc, eq, inArray, isNull, or, type SQL, sql } from 'drizzle-orm';
import type { CatalogFocus, SongCatalogDTO, SongListItem } from '../../../lib/dto/catalog';
import {
  artistAliases,
  compositionAltTitles,
  compositions,
  metadataTerms,
  parties,
  recordingArtists,
  recordingContributors,
  recordingLinks,
  recordings,
  recordingTerms,
  releases,
  releaseTracks,
} from '../../db/schema/workspace.generated';
import { requirePermission } from '../permissions';
import { failure, type ServiceResult, success } from '../service-result';
import type { TenantContext } from '../tenant-context';
import { getWorkspaceDatabase, sanitized, type WorkspaceDatabase } from '../workspace-connections';

/** Title normalization (§3.5): lowercase, trimmed, internal whitespace collapsed to one space. */
export const normalizeTitle = (title: string) => title.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * The primary recording (§3.5): a song's only live recording; otherwise the only one whose
 * normalized title equals the song title and whose version title is NULL, or none.
 */
function primaryRecording<T extends { title: string; versionTitle: string | null }>(
  title: string,
  songRecordings: T[],
): T | undefined {
  if (songRecordings.length === 1) return songRecordings[0];
  const same = (recording: T) =>
    recording.versionTitle === null && normalizeTitle(recording.title) === normalizeTitle(title);
  const matches = songRecordings.filter(same);
  return matches.length === 1 ? matches[0] : undefined;
}

/** `rows` grouped by recording id, each without it, in row order. */
function byRecording<T extends { recordingId: string }>(rows: T[]) {
  const groups = new Map<string, Omit<T, 'recordingId'>[]>();
  for (const { recordingId, ...row } of rows) {
    groups.set(recordingId, [...(groups.get(recordingId) ?? []), row]);
  }
  return groups;
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** catalog:read for the role resolved for this request (§6.2); a comma role fails closed (P-30). */
const canRead = (tenant: TenantContext) => requirePermission(tenant, { catalog: ['read'] }).ok;

const COMPOSITION = {
  id: compositions.id,
  title: compositions.title,
  iswc: compositions.iswc,
  copyrightRegistrationNumber: compositions.copyrightRegistrationNumber,
  copyrightDate: compositions.copyrightDate,
  description: compositions.description,
  hasLyrics: sql`coalesce(${compositions.lyrics}, '') <> ''`.mapWith(Boolean),
};

const RECORDING = {
  compositionId: recordings.compositionId,
  recording: {
    id: recordings.id,
    title: recordings.title,
    versionTitle: recordings.versionTitle,
    isrc: recordings.isrc,
    durationMs: recordings.durationMs,
    bpm: recordings.bpm,
    musicalKey: recordings.musicalKey,
    previewStartMs: recordings.previewStartMs,
  },
};

const RECORDING_ORDER = [asc(recordings.title), asc(recordings.versionTitle), asc(recordings.id)];

const LINK = {
  recordingId: recordingLinks.recordingId,
  id: recordingLinks.id,
  linkType: recordingLinks.linkType,
  label: recordingLinks.label,
  url: recordingLinks.url,
  isPrimary: sql`${recordingLinks.isPrimary} = 1`.mapWith(Boolean),
};

const CONTRIBUTOR = {
  recordingId: recordingContributors.recordingId,
  partyId: recordingContributors.partyId,
  displayName: parties.displayName,
  role: recordingContributors.role,
  creditText: recordingContributors.creditText,
};

const TERM = {
  recordingId: recordingTerms.recordingId,
  id: metadataTerms.id,
  termType: metadataTerms.termType,
  label: metadataTerms.label,
};

const RELEASE = {
  id: releases.id,
  title: releases.title,
  releaseType: releases.releaseType,
  upcEan: releases.upcEan,
  releaseDate: releases.releaseDate,
  recordingId: releaseTracks.recordingId,
  discNumber: releaseTracks.discNumber,
  trackNumber: releaseTracks.trackNumber,
};

/** Recording artists in billing order, named by the credited artist alias when set (CAT-008). */
const artistRows = (database: WorkspaceDatabase, where: SQL | undefined) =>
  database
    .select({
      recordingId: recordingArtists.recordingId,
      partyId: recordingArtists.partyId,
      artistAliasId: recordingArtists.artistAliasId,
      displayName: sql<string>`coalesce(${artistAliases.aliasName}, ${parties.displayName})`,
      role: recordingArtists.role,
      billingOrder: recordingArtists.billingOrder,
    })
    .from(recordingArtists)
    .innerJoin(parties, eq(parties.id, recordingArtists.partyId))
    .leftJoin(artistAliases, eq(artistAliases.id, recordingArtists.artistAliasId))
    .where(where)
    .orderBy(asc(recordingArtists.billingOrder), asc(recordingArtists.id));

/**
 * The song list (CAT-009, §3.5): one row per live composition with its live recordings, plus one
 * per live recording without a composition, sorted by normalized title, then id. A refused role
 * never opens the database; the reads share one batch, so one round trip (§1.4).
 */
export async function listSongs(tenant: TenantContext): Promise<ServiceResult<SongListItem[]>> {
  if (!canRead(tenant)) return failure('FORBIDDEN');
  return sanitized(tenant.workspaceId, async () => {
    const database = await getWorkspaceDatabase(tenant.workspaceId);
    const [songs, altTitles, songRecordings, artists] = await database.batch([
      database.select(COMPOSITION).from(compositions).where(isNull(compositions.deletedAt)),
      database.select().from(compositionAltTitles).orderBy(asc(compositionAltTitles.title)),
      database
        .select(RECORDING)
        .from(recordings)
        .where(isNull(recordings.deletedAt))
        .orderBy(...RECORDING_ORDER),
      artistRows(database, eq(recordingArtists.role, 'primary')),
    ]);
    const altTitlesOf = Map.groupBy(altTitles, (row) => row.compositionId);
    const recordingsOf = Map.groupBy(songRecordings, (row) => row.compositionId);
    const artistsOf = byRecording(artists);
    type Head = Pick<SongListItem, 'compositionId' | 'title' | 'iswc'>;
    const song = (head: Head, rows: typeof songRecordings): SongListItem => {
      const list = rows.map(({ recording }) => recording);
      const credits = list.flatMap(({ id }) => artistsOf.get(id) ?? []);
      const alternates = head.compositionId ? (altTitlesOf.get(head.compositionId) ?? []) : [];
      return {
        ...head,
        primaryRecordingId: primaryRecording(head.title, list)?.id ?? null,
        altTitles: alternates.map((alternate) => alternate.title),
        primaryArtistNames: [...new Set(credits.map(({ displayName }) => displayName))],
        recordings: list.map(({ id, title, versionTitle, isrc }) => ({
          ...{ recordingId: id, title, versionTitle, isrc },
        })),
      };
    };
    const items = [
      ...songs.map(({ id, title, iswc }) =>
        song({ compositionId: id, title, iswc }, recordingsOf.get(id) ?? []),
      ),
      ...(recordingsOf.get(null) ?? []).map((row) =>
        song({ compositionId: null, title: row.recording.title, iswc: null }, [row]),
      ),
    ];
    const id = (item: SongListItem) => item.compositionId ?? item.primaryRecordingId ?? '';
    const title = (item: SongListItem) => normalizeTitle(item.title);
    items.sort((a, b) => compare(title(a), title(b)) || compare(id(a), id(b)));
    return success(items);
  });
}

/**
 * The catalog part of MusicWorkspaceDTO (§3.4) for the song a composition or recording id names; a
 * recording resolves to its composition's song. An id with no live row in the tenant's own database
 * is NOT_FOUND, so an id from another workspace never resolves (§3.1, TEN-001). One batch.
 */
export async function getSongCatalog(
  tenant: TenantContext,
  { entityType, entityId }: CatalogFocus,
): Promise<ServiceResult<SongCatalogDTO>> {
  if (!canRead(tenant)) return failure('FORBIDDEN');
  return sanitized(tenant.workspaceId, async (): Promise<ServiceResult<SongCatalogDTO>> => {
    const database = await getWorkspaceDatabase(tenant.workspaceId);
    const isComposition = entityType === 'composition';
    // The song's composition: the id itself, or the composition of the live recording it names.
    const named = and(eq(recordings.id, entityId), isNull(recordings.deletedAt));
    const owner = database.select({ id: recordings.compositionId }).from(recordings).where(named);
    const inSong = (column: Column) =>
      isComposition ? eq(column, entityId) : inArray(column, owner);
    const alone = isComposition ? undefined : eq(recordings.id, entityId);
    const songRecording = and(
      isNull(recordings.deletedAt),
      or(inSong(recordings.compositionId), alone),
    );
    const ids = database.select({ id: recordings.id }).from(recordings).where(songRecording);
    const ofSong = (column: Column) => inArray(column, ids);
    const [found, altTitles, songRecordings, links, artists, contributors, terms, songReleases] =
      await database.batch([
        database
          .select(COMPOSITION)
          .from(compositions)
          .where(and(inSong(compositions.id), isNull(compositions.deletedAt))),
        database
          .select({ title: compositionAltTitles.title })
          .from(compositionAltTitles)
          .where(inSong(compositionAltTitles.compositionId))
          .orderBy(asc(compositionAltTitles.title)),
        database
          .select(RECORDING)
          .from(recordings)
          .where(songRecording)
          .orderBy(...RECORDING_ORDER),
        database
          .select(LINK)
          .from(recordingLinks)
          .where(ofSong(recordingLinks.recordingId))
          .orderBy(
            desc(recordingLinks.isPrimary),
            asc(recordingLinks.createdAt),
            asc(recordingLinks.id),
          ),
        artistRows(database, ofSong(recordingArtists.recordingId)),
        database
          .select(CONTRIBUTOR)
          .from(recordingContributors)
          .innerJoin(parties, eq(parties.id, recordingContributors.partyId))
          .where(ofSong(recordingContributors.recordingId))
          .orderBy(asc(recordingContributors.role), asc(parties.displayName)),
        database
          .select(TERM)
          .from(recordingTerms)
          .innerJoin(metadataTerms, eq(metadataTerms.id, recordingTerms.termId))
          .where(ofSong(recordingTerms.recordingId))
          .orderBy(asc(metadataTerms.termType), asc(metadataTerms.label)),
        database
          .select(RELEASE)
          .from(releaseTracks)
          .innerJoin(releases, eq(releases.id, releaseTracks.releaseId))
          .where(and(ofSong(releaseTracks.recordingId), isNull(releases.deletedAt)))
          .orderBy(asc(releases.releaseDate), asc(releases.title), asc(releaseTracks.discNumber)),
      ]);

    const [composition] = found;
    const focused = songRecordings.find(({ recording }) => recording.id === entityId);
    // A recording id names no song when the recording, or the composition it belongs to, is not live.
    const orphaned = focused !== undefined && focused.compositionId !== null && !composition;
    if (isComposition ? !composition : !focused || orphaned) return failure('NOT_FOUND');
    const linksOf = byRecording(links);
    const artistsOf = byRecording(artists);
    const contributorsOf = byRecording(contributors);
    const termsOf = byRecording(terms);
    const recordingDtos = songRecordings.map(({ recording }) => ({
      ...recording,
      primaryLink: linksOf.get(recording.id)?.find((link) => link.isPrimary) ?? null,
      links: linksOf.get(recording.id) ?? [],
      artists: artistsOf.get(recording.id) ?? [],
      contributors: contributorsOf.get(recording.id) ?? [],
      terms: termsOf.get(recording.id) ?? [],
    }));
    return success({
      focus: { entityType, entityId },
      composition: composition
        ? { ...composition, altTitles: altTitles.map((alt) => alt.title) }
        : null,
      primaryRecordingId: primaryRecording(composition?.title ?? '', recordingDtos)?.id ?? null,
      recordings: recordingDtos,
      releases: songReleases,
    });
  });
}
