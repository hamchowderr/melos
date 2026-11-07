import { and, asc, eq, gte, lt } from 'drizzle-orm';
import { pitchEvents } from '../../db/schema/workspace.generated';
import { getReadinessIssues } from '../rights/read';
import { failure, type ServiceResult, success } from '../service-result';
import type { TenantContext } from '../tenant-context';
import { getWorkspaceDatabase, sanitized } from '../workspace-connections';

const DAY_MS = 86_400_000;

/** What a message_sent event records for the North Star (melos-ajt.1), beside its messageId. */
export type SentFacts = { messageId: string; packageComplete?: boolean; followUpOnTime?: boolean };

/**
 * The North Star for one week (melos-ajt.1): songs sent to a pitch target with a complete metadata
 * package (the song was one-stop ready when it was sent), follow-ups sent and how many by their due
 * date, and when the workspace first sent a complete package (activation). Songs made pitch-ready
 * and catalogs imported are not recorded yet (null); imports land in Phase 10.
 */
export type NorthStarWeekDTO = {
  weekStart: string;
  weekEnd: string;
  songsPitchedComplete: number;
  songsPitched: number;
  followUpsSent: number;
  followUpsOnTime: number;
  firstCompletePackageAt: string | null;
  songsMadePitchReady: null;
  catalogsImported: null;
};

/**
 * The cells whose song is one-stop ready now: a recording cell by its recording, a composition cell
 * when one of its recordings is. A role without rights:read sees none ready.
 */
export async function oneStopReadyCells(
  tenant: TenantContext,
  cells: { id: string; compositionId: string | null; recordingId: string | null }[],
): Promise<Set<string>> {
  const report = await getReadinessIssues(tenant, { onlyNotReady: false, limit: 200 });
  if (!report.ok) return new Set();
  const ready = report.value.recordings.filter((recording) => recording.oneStopReady);
  const recordings = new Set(ready.map((recording) => recording.recordingId));
  const compositions = new Set(ready.map((recording) => recording.compositionId));
  return new Set(
    cells
      .filter((cell) =>
        cell.recordingId ? recordings.has(cell.recordingId) : compositions.has(cell.compositionId),
      )
      .map((cell) => cell.id),
  );
}

/** getNorthStarWeek for the 7 UTC days from `weekStart` (YYYY-MM-DD). Owner only. */
export async function getNorthStarWeek(
  tenant: TenantContext,
  weekStart: string,
): Promise<ServiceResult<NorthStarWeekDTO>> {
  if (tenant.workspaceRole !== 'owner') return failure('FORBIDDEN');
  const start = Date.parse(`${weekStart}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart) || Number.isNaN(start))
    return failure({ code: 'VALIDATION', field: 'weekStart', reason: 'date' });
  const [from, to] = [new Date(start).toISOString(), new Date(start + 7 * DAY_MS).toISOString()];
  const sent = eq(pitchEvents.eventType, 'message_sent');
  const [week, all] = await sanitized(tenant.workspaceId, async () => {
    const database = await getWorkspaceDatabase(tenant.workspaceId);
    const columns = {
      ...{ pitchItemId: pitchEvents.pitchItemId, metadataJson: pitchEvents.metadataJson },
      occurredAt: pitchEvents.occurredAt,
    };
    return Promise.all([
      database
        .select(columns)
        .from(pitchEvents)
        .where(and(sent, gte(pitchEvents.occurredAt, from), lt(pitchEvents.occurredAt, to))),
      database.select(columns).from(pitchEvents).where(sent).orderBy(asc(pitchEvents.occurredAt)),
    ]);
  });
  const facts = (row: { metadataJson: string | null }) =>
    JSON.parse(row.metadataJson ?? '{}') as Partial<SentFacts>;
  const cells = (rows: typeof week) => new Set(rows.map((row) => row.pitchItemId)).size;
  const followUps = new Map<string, boolean>();
  for (const row of week) {
    const { messageId, followUpOnTime } = facts(row);
    if (messageId && followUpOnTime !== undefined) followUps.set(messageId, followUpOnTime);
  }
  return success({
    ...{ weekStart, weekEnd: new Date(start + 6 * DAY_MS).toISOString().slice(0, 10) },
    songsPitchedComplete: cells(week.filter((row) => facts(row).packageComplete)),
    songsPitched: cells(week),
    followUpsSent: followUps.size,
    followUpsOnTime: [...followUps.values()].filter(Boolean).length,
    firstCompletePackageAt: all.find((row) => facts(row).packageComplete)?.occurredAt ?? null,
    ...{ songsMadePitchReady: null, catalogsImported: null },
  });
}
