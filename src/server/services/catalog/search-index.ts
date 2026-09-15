import { sql } from 'drizzle-orm';
import type { WorkspaceTransaction } from '../workspace-write';

const INTO = sql.raw(
  'INSERT INTO catalog_search (entity_type, entity_id, title, alt_titles, artist_names, contributor_names, terms, lyrics)',
);

/**
 * Re-derives one song's catalog_search rows (CAT-001, §4.3) in the caller's write transaction. It
 * deletes the rows of the composition and of every recording that names it, live or deleted, then
 * inserts the live composition and its live recordings with docs/fixtures/validate.mjs's
 * derivation, which the Northstar seed also runs, limited to the song; so the index always equals
 * a rebuild of the whole catalog. Titles are stored as written, as that derivation stores them; a
 * normalized comparison uses normalizeTitle in JS (§3.5).
 *
 * Limits: it covers only songs with a composition, so a recording without one is not reindexed
 * here. A write that moves a recording to another composition must reindex both songs, because the
 * old song's row still lists the moved recording's artists.
 */
export async function reindexSong(tx: Pick<WorkspaceTransaction, 'run'>, compositionId: string) {
  const takes = sql`SELECT id FROM recordings WHERE composition_id = ${compositionId}`;
  await tx.run(sql`DELETE FROM catalog_search
    WHERE (entity_type = 'composition' AND entity_id = ${compositionId})
      OR (entity_type = 'recording' AND entity_id IN (${takes}))`);
  await tx.run(sql`${INTO}
    SELECT 'composition', c.id, c.title,
      COALESCE((SELECT group_concat(a.title, ' ') FROM composition_alt_titles a WHERE a.composition_id = c.id), ''),
      COALESCE((SELECT group_concat(DISTINCT p.display_name) FROM recordings r JOIN recording_artists ra ON ra.recording_id = r.id
                JOIN parties p ON p.id = ra.party_id WHERE r.composition_id = c.id AND r.deleted_at IS NULL), ''),
      COALESCE((SELECT group_concat(p.display_name, ' ') FROM composition_contributors cc JOIN parties p ON p.id = cc.party_id WHERE cc.composition_id = c.id), ''),
      COALESCE((SELECT group_concat(t.label, ' ') FROM composition_terms ct JOIN metadata_terms t ON t.id = ct.term_id WHERE ct.composition_id = c.id), ''),
      COALESCE(c.lyrics, '')
    FROM compositions c WHERE c.deleted_at IS NULL AND c.id = ${compositionId}`);
  await tx.run(sql`${INTO}
    SELECT 'recording', r.id, trim(r.title || ' ' || COALESCE(r.version_title, '')), '',
      COALESCE((SELECT group_concat(p.display_name, ' ') FROM recording_artists ra JOIN parties p ON p.id = ra.party_id WHERE ra.recording_id = r.id), ''),
      COALESCE((SELECT group_concat(p.display_name, ' ') FROM recording_contributors rc JOIN parties p ON p.id = rc.party_id WHERE rc.recording_id = r.id), ''),
      COALESCE((SELECT group_concat(t.label, ' ') FROM recording_terms rt JOIN metadata_terms t ON t.id = rt.term_id WHERE rt.recording_id = r.id), ''),
      ''
    FROM recordings r WHERE r.deleted_at IS NULL AND r.composition_id = ${compositionId}`);
}
