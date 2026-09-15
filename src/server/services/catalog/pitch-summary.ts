import { asc, count, inArray, or, sql } from 'drizzle-orm';
import type { SongPitchSummaryDTO } from '../../../lib/dto/catalog';
import { pitchItems } from '../../db/schema/workspace.generated';
import type { ScopeIds } from '../rights/read';
import type { WorkspaceDatabase } from '../workspace-connections';

/** A cell's latest event: on the cell, or on its pitch with no cell named. */
const lastActivity = sql<
  string | null
>`max((select max(e.occurred_at) from pitch_events e where e.pitch_id = "pitch_items"."pitch_id" and (e.pitch_item_id is null or e.pitch_item_id = "pitch_items"."id")))`;

/**
 * A read-only statement for the caller's batch (D-6; PitchService takes it over in phase 8): the
 * pitch cells on a scope's live compositions or live recordings, per status, with their latest event.
 */
export const pitchSummaryRead = (database: WorkspaceDatabase, { songIds, takeIds }: ScopeIds) =>
  database
    .select({ status: pitchItems.currentStatus, cells: count(), lastActivityAt: lastActivity })
    .from(pitchItems)
    .where(or(inArray(pitchItems.compositionId, songIds), inArray(pitchItems.recordingId, takeIds)))
    .groupBy(pitchItems.currentStatus)
    .orderBy(asc(pitchItems.currentStatus));

/** The MusicWorkspaceDTO pitch summary (§3.4) from pitchSummaryRead's rows. */
export function pitchSummaryOf(
  rows: Awaited<ReturnType<typeof pitchSummaryRead>>,
): SongPitchSummaryDTO {
  const activity = rows.flatMap(({ lastActivityAt }) => lastActivityAt ?? []).sort();
  return {
    itemCount: rows.reduce((total, { cells }) => total + cells, 0),
    countsByStatus: Object.fromEntries(rows.map(({ status, cells }) => [status, cells])),
    lastActivityAt: activity.at(-1) ?? null,
  };
}
