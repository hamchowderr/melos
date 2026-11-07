import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ServiceResult } from '../../src/server/services/service-result';
import type { TenantContext } from '../../src/server/services/tenant-context';
import { NORTHSTAR, seedNorthstarTenant } from './catalog-support';
import { prepareWorkspaceServices, withRole } from './workspace-service';

type Services = Awaited<ReturnType<typeof prepareWorkspaceServices>>;
type Writes = typeof import('../../src/server/services/pitches/write');

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

beforeAll(async () => {
  services = await prepareWorkspaceServices('pitches-write');
  service = await import('../../src/server/services/pitches/write');
  owner = await seedNorthstarTenant();
});

afterAll(async () => {
  if (owner) await services.connections.closeWorkspaceDatabase(owner.workspaceId);
  await services?.close();
});

describe('melos-ajt.3: PitchService writes cells and their events (CRM-002, CRM-004)', () => {
  it('createPitch writes draft cells with item_added events and a note, without audit rows', async () => {
    const before = await counts();
    const pitch = accepted(
      await service.createPitch(owner, {
        contactId: k.con_THEO,
        items: [
          { itemType: 'recording', itemId: k.rec_NEON },
          { itemType: 'composition', itemId: k.cmp_HOME },
        ],
        ...{ subject: ' Two for Blue Lantern ', note: 'Send after the cue sheet' },
      }),
    );
    expect(pitch).toMatchObject({ contactId: k.con_THEO, subject: 'Two for Blue Lantern' });
    expect(pitch.items.map((item) => [item.itemTitle, item.currentStatus])).toEqual([
      ['Neon Static', 'draft'],
      ['Home Again', 'draft'],
    ]);
    expect(pitch.events.map((event) => event.eventType)).toEqual([
      'item_added',
      'item_added',
      'note_added',
    ]);
    expect(await counts()).toEqual({
      ...before,
      events: before.events + 3,
      cells: before.cells + 2,
      pitches: before.pitches + 1,
    });
    await noForeignKeyErrors();

    const added = accepted(
      await service.addPitchItem(owner, {
        ...{ pitchId: pitch.pitchId, itemType: 'recording', itemId: k.rec_PAPER },
      }),
    );
    expect(added.items.map((item) => item.itemTitle)).toEqual([
      'Neon Static',
      'Home Again',
      'Paper Planes at 2AM',
    ]);
    const twice = { pitchId: pitch.pitchId, itemType: 'recording', itemId: k.rec_PAPER } as const;
    expect(await service.addPitchItem(owner, twice)).toEqual(
      refusal({ code: 'VALIDATION', field: 'itemId', reason: 'duplicate_item' }),
    );
    // Home Again's recording would hold the song at both levels (§4.4 rule 3).
    const level = { ...twice, itemId: k.rec_HOME };
    expect(await service.addPitchItem(owner, level)).toMatchObject(
      refusal({ code: 'SONG_LEVEL_CONFLICT' }),
    );
  });

  it('refuses bad createPitch input and roles, writing nothing', async () => {
    const before = await counts();
    const items = [{ itemType: 'recording', itemId: k.rec_OCEAN }] as const;
    expect(await service.createPitch(owner, { contactId: k.con_MALIK, items: [] })).toEqual(
      refusal({ code: 'VALIDATION', field: 'items', reason: 'required' }),
    );
    expect(
      await service.createPitch(owner, { contactId: k.con_MALIK, items: [items[0], items[0]] }),
    ).toEqual(refusal({ code: 'VALIDATION', field: 'items', reason: 'duplicate_item' }));
    expect(
      await service.createPitch(owner, { contactId: 'con_missing', items: [...items] }),
    ).toEqual(refusal({ code: 'NOT_FOUND' }));
    const missingSong = [{ itemType: 'recording', itemId: 'rec_missing' }] as const;
    expect(
      await service.createPitch(owner, { contactId: k.con_MALIK, items: [...missingSong] }),
    ).toMatchObject(refusal({ code: 'NOT_FOUND' }));
    const viewer = withRole(owner, 'viewer');
    expect(
      await service.createPitch(viewer, { contactId: k.con_MALIK, items: [...items] }),
    ).toEqual(refusal({ code: 'FORBIDDEN' }));
    expect(await counts()).toEqual(before);
  });
});
