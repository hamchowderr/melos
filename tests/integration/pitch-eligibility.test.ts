import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ServiceResult } from '../../src/server/services/service-result';
import type { TenantContext } from '../../src/server/services/tenant-context';
import { NORTHSTAR, seedNorthstarTenant } from './catalog-support';
import { prepareWorkspaceServices } from './workspace-service';

type Services = Awaited<ReturnType<typeof prepareWorkspaceServices>>;

let services: Services;
let eligibility: typeof import('../../src/server/services/pitches/eligibility');
let status: typeof import('../../src/server/services/pitches/status');
let owner: TenantContext;
const k = NORTHSTAR.keys;

function accepted<T>(result: ServiceResult<T>): T {
  if (!result.ok) throw new Error(`Refused with ${JSON.stringify(result.error)}`);
  return result.value;
}
const names = (rows: { contactId: string }[]) => rows.map((row) => row.contactId);

beforeAll(async () => {
  services = await prepareWorkspaceServices('pitch-eligibility');
  eligibility = await import('../../src/server/services/pitches/eligibility');
  status = await import('../../src/server/services/pitches/status');
  owner = await seedNorthstarTenant();
});

afterAll(async () => {
  if (owner) await services.connections.closeWorkspaceDatabase(owner.workspaceId);
  await services?.close();
});

describe('melos-ajt.4: searchPitchEligibility (CRM-006, P-36)', () => {
  it('DEMO-005: Maya and Theo are planned for Home Again; Rebecca and Malik never pitched', async () => {
    for (const item of [
      { itemType: 'composition', itemId: k.cmp_HOME },
      { itemType: 'recording', itemId: k.rec_HOME },
    ] as const) {
      const result = accepted(await eligibility.searchPitchEligibility(owner, item));
      expect(result.item).toEqual({ ...item, title: 'Home Again' });
      // Rebecca is a licensing agent, so she ranks before Malik, a record label.
      expect(names(result.neverPitched)).toEqual([k.con_REBECCA, k.con_MALIK]);
      expect(result.plannedNotContacted).toEqual([
        {
          ...{ contactId: k.con_MAYA, displayName: 'Maya Chen', roles: ['music_supervisor'] },
          ...{ pitchId: k.pit_HOME_MAYA, pitchItemId: k.pti_HOME_MAYA },
          currentStatus: 'not_contacted',
        },
        expect.objectContaining({ contactId: k.con_THEO, pitchItemId: k.pti_HOME_THEO }),
      ]);
    }
  });

  it('counts a composition cell for its recording and an archived sent cell as heard', async () => {
    // Maya's Neon Static cell is on the composition; it counts for the recording too.
    const neon = accepted(
      await eligibility.searchPitchEligibility(owner, {
        itemType: 'recording',
        itemId: k.rec_NEON,
      }),
    );
    expect(names(neon.neverPitched)).toEqual([k.con_THEO]);
    // Theo heard Midnight Drive before the cell was archived.
    const midnight = { itemType: 'composition', itemId: k.cmp_MIDNIGHT } as const;
    expect(
      names(accepted(await eligibility.searchPitchEligibility(owner, midnight)).neverPitched),
    ).toEqual([k.con_MALIK]);
  });

  it('a cell archived from not_contacted is neither heard nor planned', async () => {
    const pitchItemId = k.pti_OCEAN_THEO;
    accepted(await status.transitionPitchStatus(owner, { pitchItemId, toStatus: 'archived' }));
    const ocean = { itemType: 'composition', itemId: k.cmp_OCEAN } as const;
    const result = accepted(await eligibility.searchPitchEligibility(owner, ocean));
    expect(result.plannedNotContacted).toEqual([]);
    expect(names(result.neverPitched)).toContain(k.con_THEO);
    expect(await eligibility.searchPitchEligibility(owner, { ...ocean, itemId: 'cmp_x' })).toEqual({
      ok: false,
      error: { code: 'NOT_FOUND' },
    });
    const database = await services.connections.getWorkspaceDatabase(owner.workspaceId);
    expect(await database.all(sql`PRAGMA foreign_key_check`)).toEqual([]);
  });
});
