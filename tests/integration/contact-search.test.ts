import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ServiceResult } from '../../src/server/services/service-result';
import type { TenantContext } from '../../src/server/services/tenant-context';
import { NORTHSTAR, seedNorthstarTenant } from './catalog-support';
import { prepareWorkspaceServices, withRole } from './workspace-service';

type Services = Awaited<ReturnType<typeof prepareWorkspaceServices>>;

let services: Services;
let search: typeof import('../../src/server/services/contacts/search');
let contacts: typeof import('../../src/server/services/contacts/contacts');
let owner: TenantContext;
const k = NORTHSTAR.keys;

function accepted<T>(result: ServiceResult<T>): T {
  if (!result.ok) throw new Error(`Refused with ${JSON.stringify(result.error)}`);
  return result.value;
}
const names = (rows: { contactId: string }[]) => rows.map((row) => row.contactId);

beforeAll(async () => {
  services = await prepareWorkspaceServices('contact-search');
  search = await import('../../src/server/services/contacts/search');
  contacts = await import('../../src/server/services/contacts/contacts');
  owner = await seedNorthstarTenant();
});

afterAll(async () => {
  if (owner) await services.connections.closeWorkspaceDatabase(owner.workspaceId);
  await services?.close();
});

describe('melos-ajt.4: searchContacts and ContactDetailDTO (CRM-001)', () => {
  it('lists the 4 contacts by name with company, roles, email and open cells', async () => {
    const all = accepted(await search.searchContacts(owner));
    expect(names(all)).toEqual([k.con_MALIK, k.con_MAYA, k.con_REBECCA, k.con_THEO]);
    const rebecca = all.find((row) => row.contactId === k.con_REBECCA);
    expect(rebecca).toEqual({
      ...{ contactId: k.con_REBECCA, partyId: k.pty_REBECCA, displayName: 'Rebecca Carter' },
      ...{ organizationPartyId: k.pty_CARTER_SYNC, organizationName: 'Carter Sync Agency' },
      ...{ roles: ['licensing_agent'], primaryEmail: 'rebecca@cartersync.example' },
      openItemCount: 3,
    });
  });

  it('filters by name, company or email, by role and by song', async () => {
    const found = async (filters: Parameters<typeof search.searchContacts>[1]) =>
      names(accepted(await search.searchContacts(owner, filters)));
    expect(await found({ query: ' rebecca ' })).toEqual([k.con_REBECCA]);
    expect(await found({ query: 'CARTER SYNC' })).toEqual([k.con_REBECCA]);
    expect(await found({ query: '@cartersync' })).toEqual([k.con_REBECCA]);
    expect(await found({ roles: ['music_supervisor'] })).toEqual([k.con_MAYA, k.con_THEO]);
    const home = { itemType: 'composition', itemId: k.cmp_HOME } as const;
    expect(await found({ hasPitchFor: home })).toEqual([k.con_MAYA, k.con_THEO]);
    expect(await found({ limit: 1 })).toEqual([k.con_MALIK]);
    expect(await search.searchContacts(owner, { limit: 0 })).toEqual({
      ok: false,
      error: { code: 'VALIDATION', field: 'limit', reason: 'range' },
    });
    expect(await search.searchContacts(withRole(owner, 'owner,viewer'))).toMatchObject({
      ok: false,
    });
  });

  it('getContact lists every cell of the contact and recent messages, newest first', async () => {
    const rebecca = accepted(await contacts.getContact(owner, k.con_REBECCA));
    expect(rebecca.pitchItems.map((cell) => cell.pitchItemId).sort()).toEqual(
      ['OCEAN_REBECCA', 'MIDNIGHT_REBECCA', 'PAPER_REBECCA', 'NEON_REBECCA']
        .map((name) => k[`pti_${name}`])
        .sort(),
    );
    expect(rebecca.openItemCount).toBe(3);
    const sent = rebecca.recentMessages.map((message) => message.sentAt);
    expect(sent).toEqual([...sent].sort().reverse());
    expect(rebecca.recentMessages[0]).toMatchObject({
      ...{ messageId: k.msg_NEON_REBECCA_1, pitchId: k.pit_NEON_REBECCA, direction: 'outbound' },
    });
  });
});
