import { and, asc, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import {
  type EligibleContact,
  type PitchEligibilityDTO,
  type PitchItemInput,
  type PitchStatus,
  roleRankOf,
} from '../../../lib/dto/pitches';
import {
  compositions,
  contactRoles,
  contacts,
  parties,
  pitchEvents,
  pitches,
  pitchItems,
  recordings,
} from '../../db/schema/workspace.generated';
import { requirePermission } from '../permissions';
import { failure, type ServiceResult, success } from '../service-result';
import type { TenantContext } from '../tenant-context';
import { getWorkspaceDatabase, sanitized } from '../workspace-connections';

const UNHEARD: readonly (PitchStatus | null)[] = ['draft', 'not_contacted'];

/** By role rank, then case-insensitive display name (§3.7). */
const byRank = (a: EligibleContact, b: EligibleContact) =>
  roleRankOf(a.roles) - roleRankOf(b.roles) ||
  a.displayName.toLowerCase().localeCompare(b.displayName.toLowerCase()) ||
  a.contactId.localeCompare(b.contactId);

/**
 * searchPitchEligibility (§3.3, CRM-006, P-36): who has not heard a song. A composition's cells
 * and its recordings' cells count; for a recording, its own cells and its composition's. A contact
 * has heard it when a cell's status is past not_contacted, or the cell was archived from such a
 * status. plannedNotContacted: the rest with a live draft or not_contacted cell (the first one by
 * pitch); neverPitched: every other active contact. pitch:read; a song with no live row NOT_FOUND.
 */
export async function searchPitchEligibility(
  tenant: TenantContext,
  { itemType, itemId }: PitchItemInput,
): Promise<ServiceResult<PitchEligibilityDTO>> {
  if (!requirePermission(tenant, { pitch: ['read'] }).ok) return failure('FORBIDDEN');
  const read = await sanitized(tenant.workspaceId, async () => {
    const database = await getWorkspaceDatabase(tenant.workspaceId);
    const [song] =
      itemType === 'composition'
        ? await database
            .select({ title: compositions.title, compositionId: compositions.id })
            .from(compositions)
            .where(and(eq(compositions.id, itemId), isNull(compositions.deletedAt)))
        : await database
            .select({ title: recordings.title, compositionId: recordings.compositionId })
            .from(recordings)
            .where(and(eq(recordings.id, itemId), isNull(recordings.deletedAt)));
    if (!song) return null;
    const takes = database
      .select({ id: recordings.id })
      .from(recordings)
      .where(eq(recordings.compositionId, song.compositionId ?? ''));
    const onSong =
      itemType === 'composition'
        ? or(eq(pitchItems.compositionId, itemId), inArray(pitchItems.recordingId, takes))
        : or(
            eq(pitchItems.recordingId, itemId),
            song.compositionId ? eq(pitchItems.compositionId, song.compositionId) : undefined,
          );
    const [people, roles, cells] = await database.batch([
      database
        .select({ contactId: contacts.id, displayName: parties.displayName })
        .from(contacts)
        .innerJoin(parties, eq(parties.id, contacts.partyId))
        .where(and(isNull(contacts.deletedAt), isNull(parties.deletedAt), eq(contacts.active, 1))),
      database.select().from(contactRoles).orderBy(asc(contactRoles.role)),
      database
        .select({
          contactId: pitches.contactId,
          pitchId: pitchItems.pitchId,
          pitchItemId: pitchItems.id,
          currentStatus: pitchItems.currentStatus,
        })
        .from(pitchItems)
        .innerJoin(pitches, eq(pitches.id, pitchItems.pitchId))
        .where(onSong)
        .orderBy(asc(pitches.createdAt), asc(pitchItems.id)),
    ]);
    const archived = cells.filter((cell) => cell.currentStatus === 'archived');
    const archives = archived.length
      ? await database
          .select({ pitchItemId: pitchEvents.pitchItemId, fromStatus: pitchEvents.fromStatus })
          .from(pitchEvents)
          .where(
            and(
              inArray(
                pitchEvents.pitchItemId,
                archived.map((cell) => cell.pitchItemId),
              ),
              eq(pitchEvents.eventType, 'status_changed'),
              eq(pitchEvents.toStatus, 'archived'),
            ),
          )
          .orderBy(desc(pitchEvents.occurredAt), desc(pitchEvents.id))
      : [];
    return { song, people, roles, cells, archives };
  });
  if (!read) return failure('NOT_FOUND');
  const { song, people, roles, cells, archives } = read;
  // The latest archiving event comes first, so the first row per cell is its status before.
  const before = new Map<string, PitchStatus | null>();
  for (const { pitchItemId, fromStatus } of archives)
    if (pitchItemId && !before.has(pitchItemId)) before.set(pitchItemId, fromStatus as PitchStatus);
  const heard = (cell: (typeof cells)[number]) =>
    cell.currentStatus === 'archived'
      ? !UNHEARD.includes(before.get(cell.pitchItemId) ?? null)
      : !UNHEARD.includes(cell.currentStatus as PitchStatus);
  const result: PitchEligibilityDTO = {
    item: { itemType, itemId, title: song.title },
    plannedNotContacted: [],
    neverPitched: [],
  };
  for (const person of people) {
    const own = cells.filter((cell) => cell.contactId === person.contactId);
    if (own.some(heard)) continue;
    const entry = {
      ...person,
      roles: roles.filter((role) => role.contactId === person.contactId).map((role) => role.role),
    };
    const planned = own.find((cell) => cell.currentStatus !== 'archived');
    if (planned)
      result.plannedNotContacted.push({
        ...entry,
        ...{ pitchId: planned.pitchId, pitchItemId: planned.pitchItemId },
        currentStatus: planned.currentStatus as PitchStatus,
      });
    else result.neverPitched.push(entry);
  }
  result.plannedNotContacted.sort(byRank);
  result.neverPitched.sort(byRank);
  return success(result);
}
