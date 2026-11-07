import { and, eq, isNull, max } from 'drizzle-orm';
import { monotonicFactory, ulid } from 'ulid';
import type { WorkspacePermissions } from '../../../lib/auth/permissions';
import type { CreatePitchInput, PitchDTO, PitchItemInput } from '../../../lib/dto/pitches';
import { contacts, pitchEvents, pitches, pitchItems } from '../../db/schema/workspace.generated';
import { workspaceIntegrityGuard as guard } from '../integrity-guard';
import { failure, type ServiceResult, success } from '../service-result';
import type { TenantContext } from '../tenant-context';
import { runWorkspaceWrite, type WorkspaceTransaction, type WriteOrigin } from '../workspace-write';
import { getPitch } from './read';

const CREATE: WorkspacePermissions = { pitch: ['create'] };
const UPDATE: WorkspacePermissions = { pitch: ['update'] };
const NOTE_MAX = 5000;
// Events written in one millisecond keep their write order (§4.3 id order breaks time ties).
const nextUlid = monotonicFactory();

export const refuse = (field: string, reason: string) =>
  failure({ code: 'VALIDATION', field, reason });

/** The trimmed note, or null for none; undefined for one that is too long. */
export function noteOf(note: string | null | undefined) {
  const text = note?.trim() ?? '';
  if (text.length > NOTE_MAX) return undefined;
  return text || null;
}

/** An ISO timestamp for a follow-up date, null to leave it alone, undefined when it is no date. */
export function followUpOf(value: string | null | undefined) {
  if (value === undefined || value === null) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? undefined : new Date(time).toISOString();
}

/** A pitch_events row for the actor the write runs for (§4.3). */
export function event(
  tenant: TenantContext,
  origin: WriteOrigin,
  at: string,
  row: Pick<typeof pitchEvents.$inferInsert, 'pitchId' | 'eventType'> &
    Partial<typeof pitchEvents.$inferInsert>,
): typeof pitchEvents.$inferInsert {
  return {
    id: `pev_${nextUlid()}`,
    actorType: origin.type,
    actorId: tenant.userId,
    occurredAt: at,
    ...row,
  };
}

/** Cells for `items` from `sortOrder` on, each with its item_added event. */
function cells(
  tenant: TenantContext,
  origin: WriteOrigin,
  pitchId: string,
  items: PitchItemInput[],
  from: number,
  at: string,
) {
  const rows = items.map(({ itemType, itemId }, index) => ({
    id: `pti_${ulid()}`,
    pitchId,
    compositionId: itemType === 'composition' ? itemId : null,
    recordingId: itemType === 'recording' ? itemId : null,
    sortOrder: from + index,
    ...{ createdAt: at, updatedAt: at, createdBy: tenant.userId, updatedBy: tenant.userId },
  }));
  const events = rows.map((cell) =>
    event(tenant, origin, at, { pitchId, pitchItemId: cell.id, eventType: 'item_added' }),
  );
  return { rows, events };
}

const duplicateItems = (items: PitchItemInput[]) =>
  new Set(items.map(({ itemType, itemId }) => `${itemType}:${itemId}`)).size !== items.length;

export const touch = (
  tx: WorkspaceTransaction,
  tenant: TenantContext,
  pitchId: string,
  at: string,
) =>
  guard.update(tx, pitches, { updatedAt: at, updatedBy: tenant.userId }, eq(pitches.id, pitchId));

export const loadPitch = async (tx: WorkspaceTransaction, pitchId: string) =>
  (await tx.select().from(pitches).where(eq(pitches.id, pitchId)))[0];

/**
 * createPitch (§3.3, CRM-002): a pitch to one live contact with 1..n songs as draft cells, each
 * with an item_added event, and an optional note_added event, in one transaction (§6.10). pitch
 * events are its history, so no audit_log row (§6.6). A song twice is VALIDATION; a song at both
 * levels SONG_LEVEL_CONFLICT; a song or contact with no live row NOT_FOUND.
 */
export async function createPitch(
  tenant: TenantContext,
  input: CreatePitchInput,
  origin: WriteOrigin = { type: 'user' },
): Promise<ServiceResult<PitchDTO>> {
  if (!input.items.length) return refuse('items', 'required');
  if (duplicateItems(input.items)) return refuse('items', 'duplicate_item');
  const note = noteOf(input.note);
  if (note === undefined) return refuse('note', 'too_long');
  const written = await runWorkspaceWrite(
    tenant,
    CREATE,
    async (tx) => {
      const live = and(eq(contacts.id, input.contactId), isNull(contacts.deletedAt));
      if (!(await tx.select({ id: contacts.id }).from(contacts).where(live)).length)
        return failure('NOT_FOUND');
      const [pitchId, at, by] = [`pit_${ulid()}`, new Date().toISOString(), tenant.userId];
      const subject = input.subject?.trim() || null;
      await guard.insert(
        tx,
        pitches,
        [{ id: pitchId, contactId: input.contactId, subject, notes: note }].map((row) => ({
          ...row,
          createdAt: at,
          updatedAt: at,
          createdBy: by,
          updatedBy: by,
        })),
      );
      const { rows, events } = cells(tenant, origin, pitchId, input.items, 0, at);
      await guard.insert(tx, pitchItems, rows);
      if (note) events.push(event(tenant, origin, at, { pitchId, eventType: 'note_added', note }));
      await guard.insert(tx, pitchEvents, events);
      return success(pitchId);
    },
    origin,
  );
  return written.ok ? getPitch(tenant, written.value) : written;
}

/**
 * addPitchItem (§3.3, CRM-002): one more draft cell on a pitch, last in sort order, with its
 * item_added event. A song the pitch already holds, at either level, is refused.
 */
export async function addPitchItem(
  tenant: TenantContext,
  input: PitchItemInput & { pitchId: string },
  origin: WriteOrigin = { type: 'user' },
): Promise<ServiceResult<PitchDTO>> {
  const written = await runWorkspaceWrite(
    tenant,
    UPDATE,
    async (tx) => {
      if (!(await loadPitch(tx, input.pitchId))) return failure('NOT_FOUND');
      const column =
        input.itemType === 'composition' ? pitchItems.compositionId : pitchItems.recordingId;
      const held = and(eq(pitchItems.pitchId, input.pitchId), eq(column, input.itemId));
      if ((await tx.select({ id: pitchItems.id }).from(pitchItems).where(held)).length)
        return refuse('itemId', 'duplicate_item');
      const [{ last }] = await tx
        .select({ last: max(pitchItems.sortOrder) })
        .from(pitchItems)
        .where(eq(pitchItems.pitchId, input.pitchId));
      const at = new Date().toISOString();
      const { rows, events } = cells(tenant, origin, input.pitchId, [input], (last ?? -1) + 1, at);
      await guard.insert(tx, pitchItems, rows);
      await guard.insert(tx, pitchEvents, events);
      await touch(tx, tenant, input.pitchId, at);
      return success(input.pitchId);
    },
    origin,
  );
  return written.ok ? getPitch(tenant, written.value) : written;
}
