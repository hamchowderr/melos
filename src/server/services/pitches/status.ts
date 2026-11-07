import { and, desc, eq } from 'drizzle-orm';
import type { WorkspacePermissions } from '../../../lib/auth/permissions';
import {
  PITCH_STATUSES,
  PITCH_TRANSITIONS,
  type PitchDTO,
  type PitchNoteInput,
  type PitchStatus,
  type TransitionInput,
} from '../../../lib/dto/pitches';
import { pitchEvents, pitches, pitchItems } from '../../db/schema/workspace.generated';
import { workspaceIntegrityGuard as guard } from '../integrity-guard';
import { failure, type ServiceResult, success } from '../service-result';
import type { TenantContext } from '../tenant-context';
import { runWorkspaceWrite, type WorkspaceTransaction, type WriteOrigin } from '../workspace-write';
import { getPitch } from './read';
import { event, followUpOf, loadPitch, noteOf, refuse, touch } from './write';

const UPDATE: WorkspacePermissions = { pitch: ['update'] };

/**
 * Sets the pitch's next follow-up and writes follow_up_scheduled, unless `at` is not later than
 * its last contact (§6.4, CRM-005), which refuses and writes nothing.
 */
async function scheduleFollowUp(
  tx: WorkspaceTransaction,
  tenant: TenantContext,
  origin: WriteOrigin,
  pitch: { id: string; lastContactedAt: string | null },
  nextFollowUpAt: string,
  now: string,
) {
  if (pitch.lastContactedAt !== null && nextFollowUpAt <= pitch.lastContactedAt)
    return failure('FOLLOW_UP_BEFORE_LAST_CONTACT');
  const stamp = { updatedAt: now, updatedBy: tenant.userId };
  await guard.update(tx, pitches, { nextFollowUpAt, ...stamp }, eq(pitches.id, pitch.id));
  const metadataJson = JSON.stringify({ nextFollowUpAt });
  await guard.insert(tx, pitchEvents, [
    event(tenant, origin, now, {
      pitchId: pitch.id,
      eventType: 'follow_up_scheduled',
      metadataJson,
    }),
  ]);
  return null;
}

/** The status a cell held before it was archived: its latest status_changed event to archived. */
async function beforeArchive(tx: WorkspaceTransaction, pitchItemId: string) {
  const [row] = await tx
    .select({ from: pitchEvents.fromStatus })
    .from(pitchEvents)
    .where(
      and(
        eq(pitchEvents.pitchItemId, pitchItemId),
        eq(pitchEvents.eventType, 'status_changed'),
        eq(pitchEvents.toStatus, 'archived'),
      ),
    )
    .orderBy(desc(pitchEvents.occurredAt), desc(pitchEvents.id))
    .limit(1);
  return row?.from as PitchStatus | undefined;
}

/**
 * transitionPitchStatus (§3.3, CRM-004): moves one cell along the §6.4 table, or unarchives it to
 * the status it held before, and appends its status_changed event in the same transaction. An
 * explicit `nextFollowUpAt` also schedules the pitch's follow-up. Any other move is VALIDATION
 * `transition_not_allowed`; nothing is written.
 */
export async function transitionPitchStatus(
  tenant: TenantContext,
  input: TransitionInput,
  origin: WriteOrigin = { type: 'user' },
): Promise<ServiceResult<PitchDTO>> {
  if (!PITCH_STATUSES.includes(input.toStatus)) return refuse('toStatus', 'unknown_status');
  const note = noteOf(input.note);
  if (note === undefined) return refuse('note', 'too_long');
  const nextFollowUpAt = followUpOf(input.nextFollowUpAt);
  if (nextFollowUpAt === undefined) return refuse('nextFollowUpAt', 'timestamp');
  const written = await runWorkspaceWrite(
    tenant,
    UPDATE,
    async (tx) => {
      const [cell] = await tx.select().from(pitchItems).where(eq(pitchItems.id, input.pitchItemId));
      if (!cell) return failure('NOT_FOUND');
      const from = cell.currentStatus as PitchStatus;
      const allowed =
        from === 'archived'
          ? input.toStatus === (await beforeArchive(tx, cell.id))
          : PITCH_TRANSITIONS[from].includes(input.toStatus);
      if (!allowed) return refuse('toStatus', 'transition_not_allowed');
      const now = new Date().toISOString();
      const pitch = await loadPitch(tx, cell.pitchId);
      if (nextFollowUpAt) {
        const refused = await scheduleFollowUp(tx, tenant, origin, pitch, nextFollowUpAt, now);
        if (refused) return refused;
      } else await touch(tx, tenant, cell.pitchId, now);
      const stamp = { updatedAt: now, updatedBy: tenant.userId };
      await guard.update(
        tx,
        pitchItems,
        { currentStatus: input.toStatus, ...stamp },
        eq(pitchItems.id, cell.id),
      );
      await guard.insert(tx, pitchEvents, [
        event(tenant, origin, now, {
          ...{ pitchId: cell.pitchId, pitchItemId: cell.id, eventType: 'status_changed' },
          ...{ fromStatus: from, toStatus: input.toStatus, note },
        }),
      ]);
      return success(cell.pitchId);
    },
    origin,
  );
  return written.ok ? getPitch(tenant, written.value) : written;
}

/**
 * addPitchNote (§3.3, CRM-004): a note_added event on a pitch or one of its cells, and with
 * `nextFollowUpAt` its follow-up. An empty note is VALIDATION; a cell of another pitch NOT_FOUND.
 */
export async function addPitchNote(
  tenant: TenantContext,
  input: PitchNoteInput,
  origin: WriteOrigin = { type: 'user' },
): Promise<ServiceResult<PitchDTO>> {
  const note = noteOf(input.note);
  if (!note) return refuse('note', note === undefined ? 'too_long' : 'required');
  const nextFollowUpAt = followUpOf(input.nextFollowUpAt);
  if (nextFollowUpAt === undefined) return refuse('nextFollowUpAt', 'timestamp');
  const written = await runWorkspaceWrite(
    tenant,
    UPDATE,
    async (tx) => {
      const pitch = await loadPitch(tx, input.pitchId);
      if (!pitch) return failure('NOT_FOUND');
      const pitchItemId = input.pitchItemId ?? null;
      if (pitchItemId) {
        const own = and(eq(pitchItems.id, pitchItemId), eq(pitchItems.pitchId, pitch.id));
        if (!(await tx.select({ id: pitchItems.id }).from(pitchItems).where(own)).length)
          return failure('NOT_FOUND');
      }
      const now = new Date().toISOString();
      if (nextFollowUpAt) {
        const refused = await scheduleFollowUp(tx, tenant, origin, pitch, nextFollowUpAt, now);
        if (refused) return refused;
      } else await touch(tx, tenant, pitch.id, now);
      await guard.insert(tx, pitchEvents, [
        event(tenant, origin, now, {
          pitchId: pitch.id,
          pitchItemId,
          eventType: 'note_added',
          note,
        }),
      ]);
      return success(pitch.id);
    },
    origin,
  );
  return written.ok ? getPitch(tenant, written.value) : written;
}
