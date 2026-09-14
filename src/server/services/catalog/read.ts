import { asc, eq, isNull, type SQL, sql } from 'drizzle-orm';
import type { SongListItem } from '../../../lib/dto/catalog';
import {
  artistAliases,
  compositionAltTitles,
  compositions,
  parties,
  recordingArtists,
  recordings,
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
