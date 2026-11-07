import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PITCH_TRANSITIONS, type PitchStatus } from '../../src/lib/dto/pitches';
import { pitchEvents, pitchItems } from '../../src/server/db/schema/workspace.generated';
import type { ServiceResult } from '../../src/server/services/service-result';
import type { TenantContext } from '../../src/server/services/tenant-context';
import { NORTHSTAR, seedNorthstarTenant } from './catalog-support';
import { prepareWorkspaceServices } from './workspace-service';

type Services = Awaited<ReturnType<typeof prepareWorkspaceServices>>;
type Writes = typeof import('../../src/server/services/pitches/write') &
  typeof import('../../src/server/services/pitches/status');

let services: Services;
let service: Writes;
let owner: TenantContext;
const k = NORTHSTAR.keys;

function accepted<T>(result: ServiceResult<T>): T {
  if (!result.ok) throw new Error(`Refused with ${JSON.stringify(result.error)}`);
  return result.value;
}
const open = () => services.connections.getWorkspaceDatabase(owner.workspaceId);
const count = async (table: string) =>
  (await (await open()).all<{ n: number }>(sql.raw(`SELECT count(*) AS n FROM ${table}`)))[0].n;
const counts = async () => ({
  events: await count('pitch_events'),
  cells: await count('pitch_items'),
  pitches: await count('pitches'),
  audit: await count('audit_log'),
});
const noForeignKeyErrors = async () =>
  expect(await (await open()).all(sql`PRAGMA foreign_key_check`)).toEqual([]);
const refusal = (error: object) => ({ ok: false, error });

/** A fresh one-cell pitch to Malik on Ocean Blue, so each case starts from draft. */
const freshCell = async () => {
  const pitch = accepted(
    await service.createPitch(owner, {
      contactId: k.con_MALIK,
      items: [{ itemType: 'recording', itemId: k.rec_OCEAN }],
    }),
  );
  return pitch.items[0].pitchItemId;
};

/** Moves a cell from draft to `to` along a path the §6.4 table allows. */
const PATHS: Record<PitchStatus, PitchStatus[]> = {
  draft: [],
  not_contacted: ['not_contacted'],
  sent: ['sent'],
  awaiting_reply: ['sent', 'awaiting_reply'],
  responded: ['sent', 'responded'],
  interested: ['sent', 'interested'],
  requested_more: ['sent', 'requested_more'],
  passed: ['sent', 'passed'],
  accepted: ['sent', 'interested', 'accepted'],
  closed_won: ['sent', 'interested', 'accepted', 'closed_won'],
  closed_lost: ['sent', 'closed_lost'],
  archived: ['archived'],
};
const walk = async (pitchItemId: string, path: PitchStatus[]) => {
  for (const toStatus of path)
    accepted(await service.transitionPitchStatus(owner, { pitchItemId, toStatus }));
};

beforeAll(async () => {
  services = await prepareWorkspaceServices('pitches-status');
  service = {
    ...(await import('../../src/server/services/pitches/write')),
    ...(await import('../../src/server/services/pitches/status')),
  };
  owner = await seedNorthstarTenant();
});

afterAll(async () => {
  if (owner) await services.connections.closeWorkspaceDatabase(owner.workspaceId);
  await services?.close();
});

describe('melos-ajt.3: transitionPitchStatus and addPitchNote (CRM-004, CRM-005)', () => {
  it('CRM-INT-004: every allowed transition writes one status_changed event; others write nothing', async () => {
    const database = await open();
    for (const [from, targets] of Object.entries(PITCH_TRANSITIONS)) {
      for (const toStatus of [...targets, 'draft' as const]) {
        const pitchItemId = await freshCell();
        await walk(pitchItemId, PATHS[from as PitchStatus]);
        const before = await counts();
        const result = await service.transitionPitchStatus(owner, { pitchItemId, toStatus });
        if (!targets.includes(toStatus)) {
          expect(result).toEqual(
            refusal({ code: 'VALIDATION', field: 'toStatus', reason: 'transition_not_allowed' }),
          );
          expect(await counts()).toEqual(before);
          continue;
        }
        expect(result.ok, `${from} -> ${toStatus}`).toBe(true);
        expect(await counts()).toEqual({ ...before, events: before.events + 1 });
        const [cell] = await database
          .select()
          .from(pitchItems)
          .where(eq(pitchItems.id, pitchItemId));
        expect(cell.currentStatus).toBe(toStatus);
        const [last] = await database
          .select()
          .from(pitchEvents)
          .where(eq(pitchEvents.pitchItemId, pitchItemId))
          .orderBy(sql`occurred_at desc, id desc`)
          .limit(1);
        expect(last).toMatchObject({ eventType: 'status_changed', fromStatus: from, toStatus });
      }
    }
    await noForeignKeyErrors();
  });

  it('unarchive restores the status the cell held before it was archived', async () => {
    const pitchItemId = await freshCell();
    await walk(pitchItemId, ['sent', 'interested', 'archived']);
    expect(await service.transitionPitchStatus(owner, { pitchItemId, toStatus: 'sent' })).toEqual(
      refusal({ code: 'VALIDATION', field: 'toStatus', reason: 'transition_not_allowed' }),
    );
    const back = accepted(
      await service.transitionPitchStatus(owner, { pitchItemId, toStatus: 'interested' }),
    );
    expect(back.items[0].currentStatus).toBe('interested');
    expect(back.events.at(-1)).toMatchObject({ fromStatus: 'archived', toStatus: 'interested' });
  });

  it('CRM-INT-005: a follow-up not later than the last contact is refused and writes nothing', async () => {
    const pitchItemId = k.pti_PAPER_REBECCA; // last contacted 2026-09-04T18:00:00.000Z
    const before = await counts();
    const early = {
      pitchItemId,
      toStatus: 'interested',
      nextFollowUpAt: '2026-09-04T18:00:00Z',
    } as const;
    expect(await service.transitionPitchStatus(owner, early)).toEqual(
      refusal({ code: 'FOLLOW_UP_BEFORE_LAST_CONTACT' }),
    );
    const note = { pitchId: k.pit_PAPER_REBECCA, note: 'Chase', nextFollowUpAt: '2026-09-01' };
    expect(await service.addPitchNote(owner, note)).toEqual(
      refusal({ code: 'FOLLOW_UP_BEFORE_LAST_CONTACT' }),
    );
    expect(await counts()).toEqual(before);

    const later = { ...note, nextFollowUpAt: '2026-09-20T16:00:00Z', pitchItemId };
    const noted = accepted(await service.addPitchNote(owner, later));
    expect(noted.nextFollowUpAt).toBe('2026-09-20T16:00:00.000Z');
    expect(noted.events.slice(-2).map((event) => [event.eventType, event.note])).toEqual([
      ['follow_up_scheduled', null],
      ['note_added', 'Chase'],
    ]);
    expect(await counts()).toEqual({ ...before, events: before.events + 2 });
    expect(await service.addPitchNote(owner, { pitchId: k.pit_PAPER_REBECCA, note: ' ' })).toEqual(
      refusal({ code: 'VALIDATION', field: 'note', reason: 'required' }),
    );
    const otherCell = { pitchId: k.pit_PAPER_REBECCA, note: 'x', pitchItemId: k.pti_NEON_MAYA };
    expect(await service.addPitchNote(owner, otherCell)).toEqual(refusal({ code: 'NOT_FOUND' }));
    await noForeignKeyErrors();
  });
});
