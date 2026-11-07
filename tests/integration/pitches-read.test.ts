import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ServiceResult } from '../../src/server/services/service-result';
import type { TenantContext } from '../../src/server/services/tenant-context';
import { NORTHSTAR, seedNorthstarTenant } from './catalog-support';
import { prepareWorkspaceServices, withRole } from './workspace-service';

type Services = Awaited<ReturnType<typeof prepareWorkspaceServices>>;
type Pitches = typeof import('../../src/server/services/pitches/read');

let services: Services;
let service: Pitches;
let owner: TenantContext;
const k = NORTHSTAR.keys;
const DATE = NORTHSTAR.demo.date;

function accepted<T>(result: ServiceResult<T>): T {
  if (!result.ok) throw new Error(`Refused with ${JSON.stringify(result.error)}`);
  return result.value;
}
const cellsOf = (rows: { pitchItemId: string }[]) => rows.map((row) => row.pitchItemId).sort();
const ids = (...names: string[]) => names.map((name) => k[`pti_${name}`]).sort();

beforeAll(async () => {
  services = await prepareWorkspaceServices('pitches-read');
  service = await import('../../src/server/services/pitches/read');
  owner = await seedNorthstarTenant();
});

afterAll(async () => {
  if (owner) await services.connections.closeWorkspaceDatabase(owner.workspaceId);
  await services?.close();
});

describe('melos-ajt.2: PitchService reads pitches and cells (CRM-002, CRM-003, CRM-005)', () => {
  it('getPitch returns the DEMO-006 cell, events and message in time order', async () => {
    const pitch = accepted(await service.getPitch(owner, k.pit_PAPER_REBECCA, DATE));
    expect(pitch).toMatchObject({
      ...{ contactId: k.con_REBECCA, contactName: 'Rebecca Carter', followUpDue: true },
      subject: 'Paper Planes at 2AM: one-stop track for sync',
      lastContactedAt: '2026-09-04T18:00:00.000Z',
      nextFollowUpAt: '2026-09-11T18:00:00.000Z',
      items: [
        {
          ...{ pitchItemId: k.pti_PAPER_REBECCA, itemType: 'recording', itemId: k.rec_PAPER },
          ...{ itemTitle: 'Paper Planes at 2AM', currentStatus: 'awaiting_reply' },
          ...{ contactRoles: ['licensing_agent'], lastOutboundMessageId: k.msg_PAPER_1 },
          priorityRank: null,
        },
      ],
      messages: [
        { messageId: k.msg_PAPER_1, direction: 'outbound', purpose: 'initial', status: 'sent' },
      ],
    });
    const times = pitch.events.map((event) => event.occurredAt);
    expect(times).toEqual([...times].sort());
    expect(pitch.events.map((event) => event.eventType)).toContain('message_sent');
    expect(pitch.events.find((event) => event.eventType === 'message_sent')?.metadata).toEqual({
      messageId: k.msg_PAPER_1,
    });
  });

  it('getPitch of an unknown id is NOT_FOUND and a refused role is FORBIDDEN', async () => {
    expect(await service.getPitch(owner, 'pit_missing')).toEqual({
      ok: false,
      error: { code: 'NOT_FOUND' },
    });
    const refused = withRole(owner, 'owner,viewer');
    expect(await service.getPitch(refused, k.pit_PAPER_REBECCA)).toMatchObject({ ok: false });
    expect(await service.searchPitches(refused)).toMatchObject({ ok: false });
    expect(
      accepted(await service.getPitch(withRole(owner, 'viewer'), k.pit_PAPER_REBECCA)).pitchId,
    ).toBe(k.pit_PAPER_REBECCA);
  });

  it('searchPitches leaves out archived cells unless asked and filters by status', async () => {
    const all = accepted(await service.searchPitches(owner));
    expect(all).toHaveLength(11);
    expect(all.some((cell) => cell.currentStatus === 'archived')).toBe(false);
    const archived = accepted(await service.searchPitches(owner, { statuses: ['archived'] }));
    expect(cellsOf(archived)).toEqual(ids('MIDNIGHT_THEO', 'OCEAN_REBECCA'));
    const planned = accepted(await service.searchPitches(owner, { statuses: ['not_contacted'] }));
    expect(cellsOf(planned)).toEqual(ids('HOME_MAYA', 'HOME_THEO', 'OCEAN_THEO'));
  });

  it('searchPitches filters by contact, and a composition covers its recordings', async () => {
    const rebecca = accepted(await service.searchPitches(owner, { contactId: k.con_REBECCA }));
    expect(cellsOf(rebecca)).toEqual(ids('MIDNIGHT_REBECCA', 'PAPER_REBECCA', 'NEON_REBECCA'));
    const song = { itemType: 'composition', itemId: k.cmp_NEON } as const;
    const neon = accepted(await service.searchPitches(owner, song));
    expect(cellsOf(neon)).toEqual(ids('NEON_MALIK', 'NEON_REBECCA', 'NEON_MAYA'));
    const take = { itemType: 'recording', itemId: k.rec_NEON } as const;
    expect(cellsOf(accepted(await service.searchPitches(owner, take)))).toEqual(
      ids('NEON_MALIK', 'NEON_REBECCA'),
    );
  });

  it('followUpDueOn keeps the DEMO-010 queue for the demo date in Los Angeles', async () => {
    const due = accepted(await service.searchPitches(owner, { followUpDueOn: DATE }));
    expect(cellsOf(due)).toEqual(
      ids('PAPER_REBECCA', 'MIDNIGHT_MAYA', 'MIDNIGHT_REBECCA', 'NEON_MAYA', 'NEON_REBECCA'),
    );
    expect(due.every((cell) => cell.followUpDue)).toBe(true);
    // pti_PAPER_THEO falls due 2 hours after the demo date ends in Los Angeles.
    const next = accepted(await service.searchPitches(owner, { followUpDueOn: '2026-09-15' }));
    expect(cellsOf(next)).toContain(k.pti_PAPER_THEO);
    expect(await service.searchPitches(owner, { followUpDueOn: '14 Sept' })).toEqual({
      ok: false,
      error: { code: 'VALIDATION', field: 'followUpDueOn', reason: 'date' },
    });
  });
});
