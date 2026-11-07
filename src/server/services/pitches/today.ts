import { and, desc, eq, gt, lte } from 'drizzle-orm';
import {
  FOLLOW_UP_STATUS_RANK,
  PITCH_STATUSES,
  type PitchSummary,
  roleRankOf,
  type TodayWorkspaceDTO,
} from '../../../lib/dto/pitches';
import { dateIn, daysBetween, endOfDate } from '../../../lib/zoned-date';
import { messages } from '../../db/schema/workspace.generated';
import { getMemberTimezone } from '../member-settings';
import { requirePermission } from '../permissions';
import { getReadinessIssues } from '../rights/read';
import { failure, type ServiceResult, success } from '../service-result';
import type { TenantContext } from '../tenant-context';
import { getWorkspaceDatabase, sanitized } from '../workspace-connections';
import { searchPitchEligibility } from './eligibility';
import { searchPitches } from './read';

const WEEK_MS = 7 * 86_400_000;

/** Due cells by follow-up priority (§3.7, P-31), numbered from 1. */
export function prioritized(cells: PitchSummary[], date: string, timezone: string): PitchSummary[] {
  const overdue = (cell: PitchSummary) => daysBetween(cell.nextFollowUpAt ?? '', date, timezone);
  return [...cells]
    .sort(
      (a, b) =>
        overdue(b) - overdue(a) ||
        FOLLOW_UP_STATUS_RANK.indexOf(a.currentStatus) -
          FOLLOW_UP_STATUS_RANK.indexOf(b.currentStatus) ||
        roleRankOf(a.contactRoles) - roleRankOf(b.contactRoles) ||
        (a.nextFollowUpAt ?? '').localeCompare(b.nextFollowUpAt ?? '') ||
        a.pitchItemId.localeCompare(b.pitchItemId),
    )
    .map((cell, index) => ({ ...cell, priorityRank: index + 1 }));
}

/** Each pitch's latest reply received in the 7 days up to `endOfDay`. */
async function repliesBefore(tenant: TenantContext, endOfDay: string) {
  const since = new Date(Date.parse(endOfDay) - WEEK_MS).toISOString();
  const rows = await sanitized(tenant.workspaceId, async () => {
    const database = await getWorkspaceDatabase(tenant.workspaceId);
    return database
      .select({ pitchId: messages.pitchId, receivedAt: messages.receivedAt })
      .from(messages)
      .where(
        and(
          eq(messages.direction, 'inbound'),
          gt(messages.receivedAt, since),
          lte(messages.receivedAt, endOfDay),
        ),
      )
      .orderBy(desc(messages.receivedAt));
  });
  const latest = new Map<string, string>();
  for (const { pitchId, receivedAt } of rows)
    if (pitchId && receivedAt && !latest.has(pitchId)) latest.set(pitchId, receivedAt);
  return latest;
}

/**
 * getTodayWorkspace (§3.3, CRM-005, DEMO-010) for `date`, today in the member's timezone by
 * default (P-24). pitch:read and rights:read; a `date` that is not YYYY-MM-DD is VALIDATION.
 */
export async function getTodayWorkspace(
  tenant: TenantContext,
  input: { date?: string } = {},
): Promise<ServiceResult<TodayWorkspaceDTO>> {
  if (!requirePermission(tenant, { pitch: ['read'], rights: ['read'] }).ok)
    return failure('FORBIDDEN');
  if (input.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(input.date))
    return failure({ code: 'VALIDATION', field: 'date', reason: 'date' });
  const timezone = await getMemberTimezone(tenant);
  const date = input.date ?? dateIn(timezone);
  const [due, cells, readinessIssues, catalog] = await Promise.all([
    searchPitches(tenant, { followUpDueOn: date }),
    searchPitches(tenant, { statuses: [...PITCH_STATUSES] }),
    getReadinessIssues(tenant, { onlyNotReady: true, limit: 200 }),
    getReadinessIssues(tenant, { onlyNotReady: false, limit: 200 }),
  ]);
  if (!due.ok) return due;
  if (!cells.ok) return cells;
  if (!readinessIssues.ok) return readinessIssues;
  if (!catalog.ok) return catalog;

  const replies = await repliesBefore(tenant, endOfDate(date, timezone));
  const recentReplies = cells.value
    .flatMap((cell) => {
      const receivedAt = replies.get(cell.pitchId);
      return receivedAt ? [{ ...cell, receivedAt }] : [];
    })
    .sort(
      (a, b) =>
        b.receivedAt.localeCompare(a.receivedAt) || a.pitchItemId.localeCompare(b.pitchItemId),
    );

  const readyToPitch: TodayWorkspaceDTO['readyToPitch'] = [];
  for (const recording of catalog.value.recordings.filter((entry) => entry.oneStopReady)) {
    const item = { itemType: 'recording', itemId: recording.recordingId } as const;
    const eligible = await searchPitchEligibility(tenant, item);
    if (!eligible.ok) return eligible;
    const agents = eligible.value.neverPitched.filter((contact) =>
      contact.roles.includes('licensing_agent'),
    ).length;
    if (agents)
      readyToPitch.push({
        ...{ recordingId: recording.recordingId, title: recording.title },
        neverPitchedLicensingAgentCount: agents,
      });
  }
  readyToPitch.sort(
    (a, b) =>
      b.neverPitchedLicensingAgentCount - a.neverPitchedLicensingAgentCount ||
      a.title.localeCompare(b.title),
  );
  return success({
    ...{ date, timezone, followUpsDue: prioritized(due.value, date, timezone), recentReplies },
    ...{ readinessIssues: readinessIssues.value, readyToPitch },
  });
}
