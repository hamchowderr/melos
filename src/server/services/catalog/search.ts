import { sql } from 'drizzle-orm';
import {
  type MatchType,
  type MusicSearchInput,
  type MusicSearchResult,
  READINESS_FILTERS,
  type SongListItem,
} from '../../../lib/dto/catalog';
import { requirePermission } from '../permissions';
import { failure, type ServiceResult, success } from '../service-result';
import type { TenantContext } from '../tenant-context';
import { getWorkspaceDatabase, sanitized } from '../workspace-connections';
import { listSongs, normalizeTitle } from './read';

const MAX_TOKENS = 12;
const refuse = (field: string, reason: string) => failure({ code: 'VALIDATION', field, reason });

/**
 * The FTS5 MATCH expression (§3.5): at most 12 whitespace-separated tokens, each in double quotes
 * with embedded quotes doubled, and `*` after the last; null when the text has no token.
 */
export function matchExpression(query: string): string | null {
  const tokens = query.trim().split(/\s+/).filter(Boolean).slice(0, MAX_TOKENS);
  if (!tokens.length) return null;
  return `${tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(' ')}*`;
}

/** A song's key: its composition id, or a lone recording's own id (§3.5). */
const keyOf = (song: SongListItem) => song.compositionId ?? song.recordings[0]?.recordingId ?? '';

const RANK: Record<MatchType, number> = { exact_title: 0, exact_alt_title: 1, text: 2 };

const ready: Record<NonNullable<MusicSearchInput['readiness']>, (song: SongListItem) => boolean> = {
  one_stop_ready: (song) => song.recordings.some((r) => r.oneStopReady),
  not_one_stop_ready: (song) => song.recordings.some((r) => !r.oneStopReady),
  sync_ready: (song) => song.recordings.some((r) => r.syncReady),
  not_sync_ready: (song) => song.recordings.some((r) => !r.syncReady),
};

/** VALIDATION for the first broken field (§3.3): query of 1 to 200 characters, limit 1 to 20. */
function invalid({ query, limit, readiness, termIds }: MusicSearchInput) {
  if (typeof query !== 'string' || query.length < 1 || query.length > 200)
    return refuse('query', 'length');
  if (limit !== undefined && !(Number.isInteger(limit) && limit >= 1 && limit <= 20))
    return refuse('limit', 'out_of_range');
  if (readiness !== undefined && !READINESS_FILTERS.includes(readiness))
    return refuse('readiness', 'not_allowed');
  if (termIds !== undefined && !Array.isArray(termIds)) return refuse('termIds', 'not_a_list');
  return null;
}

/**
 * Song keys the text index matches, recordings folded into their composition (§3.5), and the keys
 * the artist and term filters keep (null when not filtering). One batch; the MATCH expression is a
 * bound parameter, never SQL text.
 */
async function candidates(tenant: TenantContext, match: string, input: MusicSearchInput) {
  return sanitized(tenant.workspaceId, async () => {
    const database = await getWorkspaceDatabase(tenant.workspaceId);
    const songOf = sql`CASE WHEN s.entity_type = 'recording' AND r.composition_id IS NOT NULL
      THEN r.composition_id ELSE s.entity_id END`;
    const text = database.values<[string]>(sql`SELECT DISTINCT ${songOf}
      FROM catalog_search s LEFT JOIN recordings r ON s.entity_type = 'recording' AND r.id = s.entity_id
      WHERE catalog_search MATCH ${match}`);
    const songKey = sql`coalesce(r.composition_id, r.id)`;
    const artist = input.artistPartyId
      ? database.values<[string]>(sql`SELECT DISTINCT ${songKey} FROM recording_artists ra
          JOIN recordings r ON r.id = ra.recording_id
          WHERE r.deleted_at IS NULL AND ra.party_id = ${input.artistPartyId}`)
      : null;
    const terms = [...new Set(input.termIds ?? [])];
    const termed = terms.length
      ? database.values<[string]>(sql`SELECT key FROM (
          SELECT composition_id AS key, term_id FROM composition_terms
          UNION SELECT ${songKey}, rt.term_id FROM recording_terms rt
            JOIN recordings r ON r.id = rt.recording_id WHERE r.deleted_at IS NULL)
        WHERE term_id IN (${sql.join(
          terms.map((t) => sql`${t}`),
          sql`, `,
        )})
        GROUP BY key HAVING count(DISTINCT term_id) = ${terms.length}`)
      : null;
    const [found, byArtist, byTerms] = await Promise.all([text, artist, termed]);
    const keys = (rows: [string][] | null) => rows && new Set(rows.map((row) => row[0]));
    return { text: keys(found) ?? new Set<string>(), filters: [keys(byArtist), keys(byTerms)] };
  });
}

/**
 * searchMusic (CAT-009, §3.3, §3.5): one MusicSearchResult per song, exact normalized title
 * matches first, then exact alternate titles, then text matches, each by listSongs's order, cut to
 * `limit` (default 10). Text with no token returns [] without opening the database. Exact matches
 * compare with normalizeTitle in JS, since SQLite lower(trim()) differs (melos-rpr.17). catalog and
 * rights read (§6.2), as listSongs needs.
 */
export async function searchMusic(
  tenant: TenantContext,
  input: MusicSearchInput,
): Promise<ServiceResult<MusicSearchResult[]>> {
  if (!requirePermission(tenant, { catalog: ['read'], rights: ['read'] }).ok)
    return failure('FORBIDDEN');
  const refused = invalid(input);
  if (refused) return refused;
  const match = matchExpression(input.query);
  if (!match) return success([]);
  const { text, filters } = await candidates(tenant, match, input);
  const songs = await listSongs(tenant);
  if (!songs.ok) return songs;
  const wanted = normalizeTitle(input.query);
  const matchOf = (song: SongListItem): MatchType | null => {
    if (normalizeTitle(song.title) === wanted) return 'exact_title';
    if (song.altTitles.some((title) => normalizeTitle(title) === wanted)) return 'exact_alt_title';
    return text.has(keyOf(song)) ? 'text' : null;
  };
  const results = songs.value.flatMap((song) => {
    const matchType = matchOf(song);
    if (!matchType) return [];
    if (filters.some((keep) => keep && !keep.has(keyOf(song)))) return [];
    if (input.readiness && !ready[input.readiness](song)) return [];
    const recordingIds = song.recordings.map(({ recordingId }) => recordingId);
    return [{ ...song, recordingIds, matchType }];
  });
  // Array.prototype.sort is stable, so listSongs's order holds within each match type.
  results.sort((a, b) => RANK[a.matchType] - RANK[b.matchType]);
  return success(results.slice(0, input.limit ?? 10));
}
