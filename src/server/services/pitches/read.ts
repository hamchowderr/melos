import { and, asc, desc, eq, inArray, ne, or, type SQL, sql } from 'drizzle-orm';
import {
  followUpDue,
  type PitchDTO,
  type PitchEventDTO,
  type PitchMessageDTO,
  type PitchSearch,
  type PitchStatus,
  type PitchSummary,
} from '../../../lib/dto/pitches';
import { dateIn, endOfDate } from '../../../lib/zoned-date';
import {
  compositions,
  contactRoles,
  contacts,
  messages,
  parties,
  pitchEvents,
  pitches,
  pitchItems,
  recordings,
} from '../../db/schema/workspace.generated';
import { getMemberTimezone } from '../member-settings';
import { requirePermission } from '../permissions';
import { failure, type ServiceResult, success } from '../service-result';
import type { TenantContext } from '../tenant-context';
import { getWorkspaceDatabase, sanitized, type WorkspaceDatabase } from '../workspace-connections';

/** pitch:read for the role resolved for this request (§6.2); a comma role fails closed (P-30). */
const canRead = (tenant: TenantContext) => requirePermission(tenant, { pitch: ['read'] }).ok;

/** A pitch's latest sent outbound message (§3.4 lastOutboundMessageId). */
const lastOutbound = sql<string | null>`(select m.id from messages m
  where m.pitch_id = ${pitches.id} and m.direction = 'outbound' and m.status = 'sent'
  order by m.sent_at desc, m.id desc limit 1)`;

/** Cells with their pitch, contact and song title, in pitch then sort order. */
const cellRows = (database: WorkspaceDatabase, where?: SQL) =>
  database
    .select({
      pitchId: pitchItems.pitchId,
      pitchItemId: pitchItems.id,
      contactId: pitches.contactId,
      contactName: parties.displayName,
      compositionId: pitchItems.compositionId,
      recordingId: pitchItems.recordingId,
      compositionTitle: compositions.title,
      recordingTitle: recordings.title,
      versionTitle: recordings.versionTitle,
      currentStatus: sql<PitchStatus>`${pitchItems.currentStatus}`,
      nextFollowUpAt: pitches.nextFollowUpAt,
      lastContactedAt: pitches.lastContactedAt,
      lastOutboundMessageId: lastOutbound,
    })
    .from(pitchItems)
    .innerJoin(pitches, eq(pitches.id, pitchItems.pitchId))
    .innerJoin(contacts, eq(contacts.id, pitches.contactId))
    .innerJoin(parties, eq(parties.id, contacts.partyId))
    .leftJoin(compositions, eq(compositions.id, pitchItems.compositionId))
    .leftJoin(recordings, eq(recordings.id, pitchItems.recordingId))
    .where(where)
    .orderBy(
      desc(pitches.createdAt),
      asc(pitches.id),
      asc(pitchItems.sortOrder),
      asc(pitchItems.id),
    );

type CellRow = Awaited<ReturnType<typeof cellRows>>[number];

/** Each contact's roles, by contact id, in name order. */
async function rolesOf(database: WorkspaceDatabase, contactIds: string[]) {
  const rows = contactIds.length
    ? await database
        .select({ contactId: contactRoles.contactId, role: contactRoles.role })
        .from(contactRoles)
        .where(inArray(contactRoles.contactId, [...new Set(contactIds)]))
        .orderBy(asc(contactRoles.role))
    : [];
  const roles = new Map<string, string[]>();
  for (const { contactId, role } of rows)
    roles.set(contactId, [...(roles.get(contactId) ?? []), role]);
  return roles;
}

/** PitchSummary rows for `cells`, with followUpDue for the instant `endOfDay`. */
function summaries(cells: CellRow[], roles: Map<string, string[]>, endOfDay: string) {
  return cells.map((cell): PitchSummary => {
    const recording = cell.recordingId !== null;
    const title = recording ? (cell.recordingTitle ?? '') : (cell.compositionTitle ?? '');
    return {
      ...{ pitchId: cell.pitchId, pitchItemId: cell.pitchItemId, contactId: cell.contactId },
      ...{ contactName: cell.contactName, contactRoles: roles.get(cell.contactId) ?? [] },
      itemType: recording ? 'recording' : 'composition',
      itemId: (recording ? cell.recordingId : cell.compositionId) ?? '',
      itemTitle: cell.versionTitle ? `${title} (${cell.versionTitle})` : title,
      ...{ currentStatus: cell.currentStatus, nextFollowUpAt: cell.nextFollowUpAt },
      followUpDue: followUpDue(cell, endOfDay),
      ...{
        lastContactedAt: cell.lastContactedAt,
        lastOutboundMessageId: cell.lastOutboundMessageId,
      },
      priorityRank: null,
    };
  });
}

/** `end(D)` for `date`, or today, in the member's timezone (§6.4, P-24). */
async function endOfDayFor(tenant: TenantContext, date?: string) {
  const timezone = await getMemberTimezone(tenant);
  return endOfDate(date ?? dateIn(timezone), timezone);
}

/** The song filter: a composition covers its own cells and those on its recordings (§3.3). */
function itemFilter(database: WorkspaceDatabase, { itemType, itemId }: PitchSearch) {
  if (!itemType || !itemId) return undefined;
  if (itemType === 'recording') return eq(pitchItems.recordingId, itemId);
  const takes = database
    .select({ id: recordings.id })
    .from(recordings)
    .where(eq(recordings.compositionId, itemId));
  return or(eq(pitchItems.compositionId, itemId), inArray(pitchItems.recordingId, takes));
}

/**
 * searchPitches (§3.3, CRM-003, CRM-005): cells matching every filter in PitchSearch, newest pitch
 * first. pitch:read; a refused role never opens the database. A `followUpDueOn` that is not a
 * calendar date is VALIDATION.
 */
export async function searchPitches(
  tenant: TenantContext,
  search: PitchSearch = {},
): Promise<ServiceResult<PitchSummary[]>> {
  if (!canRead(tenant)) return failure('FORBIDDEN');
  const { statuses, contactId, followUpDueOn } = search;
  if (followUpDueOn !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(followUpDueOn))
    return failure({ code: 'VALIDATION', field: 'followUpDueOn', reason: 'date' });
  const endOfDay = await endOfDayFor(tenant, followUpDueOn);
  const found = await sanitized(tenant.workspaceId, async () => {
    const database = await getWorkspaceDatabase(tenant.workspaceId);
    const cells = await cellRows(
      database,
      and(
        statuses?.length
          ? inArray(pitchItems.currentStatus, statuses)
          : ne(pitchItems.currentStatus, 'archived'),
        contactId ? eq(pitches.contactId, contactId) : undefined,
        itemFilter(database, search),
      ),
    );
    return summaries(
      cells,
      await rolesOf(
        database,
        cells.map((cell) => cell.contactId),
      ),
      endOfDay,
    );
  });
  return success(followUpDueOn ? found.filter((cell) => cell.followUpDue) : found);
}

const parse = (json: string | null) =>
  json ? (JSON.parse(json) as Record<string, unknown>) : null;

/**
 * getPitch (§3.3, CRM-002): PitchDTO with every cell, archived ones included, and the pitch's events
 * and messages in time order. pitch:read; an id with no pitch in the tenant's database is NOT_FOUND.
 */
export async function getPitch(
  tenant: TenantContext,
  pitchId: string,
  date?: string,
): Promise<ServiceResult<PitchDTO>> {
  if (!canRead(tenant)) return failure('FORBIDDEN');
  const endOfDay = await endOfDayFor(tenant, date);
  const pitch = await sanitized(tenant.workspaceId, async () => {
    const database = await getWorkspaceDatabase(tenant.workspaceId);
    const [row] = await database
      .select({ subject: pitches.subject, contactId: pitches.contactId, name: parties.displayName })
      .from(pitches)
      .innerJoin(contacts, eq(contacts.id, pitches.contactId))
      .innerJoin(parties, eq(parties.id, contacts.partyId))
      .where(eq(pitches.id, pitchId));
    if (!row) return null;
    const [cells, events, mail] = await database.batch([
      cellRows(database, eq(pitchItems.pitchId, pitchId)),
      database
        .select()
        .from(pitchEvents)
        .where(eq(pitchEvents.pitchId, pitchId))
        .orderBy(asc(pitchEvents.occurredAt), asc(pitchEvents.id)),
      database
        .select()
        .from(messages)
        .where(eq(messages.pitchId, pitchId))
        .orderBy(
          asc(sql`coalesce(${messages.sentAt}, ${messages.receivedAt}, ${messages.createdAt})`),
          asc(messages.id),
        ),
    ]);
    const roles = await rolesOf(database, [row.contactId]);
    return { row, items: summaries(cells, roles, endOfDay), events, mail };
  });
  if (!pitch) return failure('NOT_FOUND');
  const { row, items, events, mail } = pitch;
  return success({
    ...{ pitchId, contactId: row.contactId, contactName: row.name, subject: row.subject, items },
    nextFollowUpAt: items[0]?.nextFollowUpAt ?? null,
    followUpDue: items.some((item) => item.followUpDue),
    lastContactedAt: items[0]?.lastContactedAt ?? null,
    events: events.map(
      (event): PitchEventDTO => ({
        ...{ eventId: event.id, pitchItemId: event.pitchItemId, eventType: event.eventType },
        fromStatus: event.fromStatus as PitchStatus | null,
        toStatus: event.toStatus as PitchStatus | null,
        actorType: event.actorType as PitchEventDTO['actorType'],
        ...{ note: event.note, metadata: parse(event.metadataJson), occurredAt: event.occurredAt },
      }),
    ),
    messages: mail.map(
      (message): PitchMessageDTO => ({
        ...{ messageId: message.id, subject: message.subject, createdAt: message.createdAt },
        direction: message.direction as PitchMessageDTO['direction'],
        purpose: message.purpose as PitchMessageDTO['purpose'],
        status: message.status as PitchMessageDTO['status'],
        ...{ inReplyToMessageId: message.inReplyToMessageId, sentAt: message.sentAt },
        receivedAt: message.receivedAt,
      }),
    ),
  });
}
