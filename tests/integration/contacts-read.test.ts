import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { ulid } from 'ulid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as tables from '../../src/server/db/schema/workspace.generated';
import type { ServiceResult } from '../../src/server/services/service-result';
import type { TenantContext } from '../../src/server/services/tenant-context';
import { prepareWorkspaceServices, withRole } from './workspace-service';

type Services = Awaited<ReturnType<typeof prepareWorkspaceServices>>;
type Contacts = typeof import('../../src/server/services/contacts/read');

const AT = '2026-09-14T17:00:00.000Z';
const fixture = JSON.parse(readFileSync('docs/fixtures/northstar-demo.json', 'utf8'));
const { keys } = fixture as { keys: Record<string, string> };
/** The second workspace's only party, Sam Rivera: a primary email and an older one that is not. */
const [SAM, EMAIL, OLD_EMAIL] = [`pty_${ulid()}`, ulid(), ulid()];
/** Sam's artist alias, the IPI that belongs to it and a society affiliation. */
const [ALIAS, IPI, BMI] = [ulid(), ulid(), ulid()];
const FORBIDDEN = { ok: false, error: { code: 'FORBIDDEN' } };
const NOT_FOUND = { ok: false, error: { code: 'NOT_FOUND' } };
let services: Services;
let connections: Services['connections'];
let getWorkspaceDatabase: Services['getWorkspaceDatabase'];
let contacts: Contacts;
let northstar: TenantContext;
let other: TenantContext;

function accepted<T>(result: ServiceResult<T>): T {
  if (!result.ok) throw new Error(`Refused with ${result.error.code}`);
  return result.value;
}
const list = async (tenant: TenantContext, options?: Parameters<Contacts['listParties']>[1]) =>
  accepted(await contacts.listParties(tenant, options));

beforeAll(async () => {
  // Every request for a workspace database is recorded through getWorkspaceDatabase.
  services = await prepareWorkspaceServices('contacts-read');
  ({ connections, getWorkspaceDatabase } = services);
  contacts = await import('../../src/server/services/contacts/read');
  const { seedNorthstar } = await import('../../src/server/db/seed/northstar');

  const seeded = await seedNorthstar({ password: 'contacts-password', seedDate: '2026-09-14' });
  expect(seeded).toMatchObject({ status: 'seeded', dateShift: 0 });
  const { organizationId, workspaceId } = seeded as Extract<typeof seeded, { status: 'seeded' }>;
  const tenant = { userId: keys.usr_JORDAN, workspaceRole: 'owner', requestId: 'people' } as const;
  northstar = { ...tenant, organizationId, workspaceId };

  other = await services.provision('owner');
  const database = await connections.getWorkspaceDatabase(other.workspaceId);
  const [partyId, createdAt, updatedAt] = [SAM, AT, AT];
  const email = (id: string, value: string, isPrimary: number, at = AT) => ({
    ...{ id, partyId, methodType: 'email', value, isPrimary, createdAt: at, updatedAt: at },
  });
  await database.batch([
    database
      .insert(tables.parties)
      .values({ id: SAM, partyKind: 'person', displayName: 'Sam Rivera', createdAt, updatedAt }),
    database.insert(tables.people).values({ partyId, legalName: 'Samuel Rivera' }),
    database
      .insert(tables.artistAliases)
      .values({ id: ALIAS, partyId, aliasName: 'DJ Sam', createdAt }),
    database.insert(tables.partyIdentifiers).values({
      ...{ id: IPI, partyId, artistAliasId: ALIAS, createdAt },
      ...{ identifierType: 'IPI', identifierValue: '00012345678' },
    }),
    database
      .insert(tables.partySocietyAffiliations)
      .values({ id: BMI, partyId, societyCode: 'BMI', role: 'writer', createdAt }),
    database
      .insert(tables.contactMethods)
      .values([
        email(OLD_EMAIL, 'sam.old@example.test', 0, '2026-09-01T17:00:00.000Z'),
        email(EMAIL, 'sam@example.test', 1),
      ]),
  ]);
});

afterAll(async () => {
  // services.close() closes the workspaces it provisioned, then melos-control.
  if (northstar) await connections.closeWorkspaceDatabase(northstar.workspaceId);
  await services?.close();
});

describe('melos-rpr.6: ContactService reads people and organizations (§2.3 /people, D-5)', () => {
  const REBECCA = {
    ...{ partyId: keys.pty_REBECCA, partyKind: 'person', displayName: 'Rebecca Carter' },
    primaryEmail: 'rebecca@cartersync.example',
    contact: {
      ...{ contactId: keys.con_REBECCA, roles: ['licensing_agent'] },
      ...{ organizationPartyId: keys.pty_CARTER_SYNC, organizationName: 'Carter Sync Agency' },
    },
  };

  it('lists 7 people and 7 organizations by name; Rebecca Carter is a licensing agent at Carter Sync Agency', async () => {
    const people = await list(northstar, { kind: 'person' });
    expect(people.map(({ displayName }) => displayName)).toEqual([
      ...['Alex Ramirez', 'Jordan Taylor', 'Malik Johnson', 'Maya Chen'],
      ...['Rebecca Carter', 'Sophia Lee', 'Theo Grant'],
    ]);
    expect(people.find(({ partyId }) => partyId === keys.pty_REBECCA)).toEqual(REBECCA);
    expect(await list(northstar, { kind: 'organization' })).toHaveLength(7);
    // query keeps the names that contain it, ignoring case and surrounding spaces.
    const agency = {
      ...{ partyId: keys.pty_CARTER_SYNC, partyKind: 'organization', primaryEmail: null },
      ...{ displayName: 'Carter Sync Agency', contact: null, organizationType: 'sync_agency' },
      people: [{ partyId: keys.pty_REBECCA, displayName: 'Rebecca Carter' }],
    };
    expect(await list(northstar, { query: ' CARTER ' })).toEqual([agency, REBECCA]);
  });

  it('reads Rebecca Carter as a person and Carter Sync Agency as an organization', async () => {
    const { primaryEmail, ...rebecca } = REBECCA;
    const method = (key: string, methodType: string, value: string) => ({
      ...{ id: keys[`contact_methods:${key}`], methodType, label: 'work', value, isPrimary: true },
    });
    expect(accepted(await contacts.getParty(northstar, keys.pty_REBECCA))).toEqual({
      ...{ ...rebecca, notes: 'Sync licensing agent (FX ICP-03)', organization: null },
      person: { legalName: 'Rebecca Carter', givenName: 'Rebecca', familyName: 'Carter' },
      methods: [
        method('REBECCA_EMAIL', 'email', primaryEmail),
        method('REBECCA_PHONE', 'phone', '+1 310-555-0127'),
      ],
      ...{ aliases: [], identifiers: [], societyAffiliations: [] },
    });
    const fields = { legalName: 'Carter Sync Agency', organizationType: 'sync_agency' };
    const agency = accepted(await contacts.getParty(northstar, keys.pty_CARTER_SYNC));
    expect(agency).toMatchObject({ person: null, organization: fields, contact: null });
  });

  it('reads an alias, an identifier with its alias, a society and primary methods first', async () => {
    const email = { methodType: 'email', label: null };
    expect(accepted(await contacts.getParty(other, SAM))).toEqual({
      ...{ partyId: SAM, partyKind: 'person', displayName: 'Sam Rivera', notes: null },
      person: { legalName: 'Samuel Rivera', givenName: null, familyName: null },
      organization: null,
      methods: [
        { ...email, id: EMAIL, value: 'sam@example.test', isPrimary: true },
        { ...email, id: OLD_EMAIL, value: 'sam.old@example.test', isPrimary: false },
      ],
      aliases: [{ id: ALIAS, aliasName: 'DJ Sam', aliasType: 'stage_name', isPrimary: false }],
      identifiers: [
        {
          ...{ id: IPI, identifierType: 'IPI', identifierValue: '00012345678', issuingBody: null },
          ...{ isPrimary: false, artistAliasId: ALIAS, aliasName: 'DJ Sam' },
        },
      ],
      societyAffiliations: [
        { id: BMI, societyCode: 'BMI', role: 'writer', startsOn: null, endsOn: null },
      ],
      contact: null,
    });
  });

  it('leaves a soft-deleted party out of the list and answers NOT_FOUND for it', async () => {
    const { parties } = tables;
    const database = await connections.getWorkspaceDatabase(northstar.workspaceId);
    const setDeletedAt = (deletedAt: string | null) =>
      database.update(parties).set({ deletedAt }).where(eq(parties.id, keys.pty_SOPHIA));
    await setDeletedAt(AT);
    try {
      const people = await list(northstar, { kind: 'person' });
      expect(people.map(({ partyId }) => partyId)).not.toContain(keys.pty_SOPHIA);
      expect(people).toHaveLength(6);
      expect(await contacts.getParty(northstar, keys.pty_SOPHIA)).toEqual(NOT_FOUND);
    } finally {
      await setDeletedAt(null);
    }
    expect(await list(northstar)).toHaveLength(14);
  });

  it('keeps each workspace to its own parties; an id from the other one is NOT_FOUND (TEN-001)', async () => {
    const sam = { partyId: SAM, partyKind: 'person', displayName: 'Sam Rivera', contact: null };
    expect(await list(other)).toEqual([{ ...sam, primaryEmail: 'sam@example.test' }]);
    expect((await list(northstar)).map(({ partyId }) => partyId)).not.toContain(SAM);
    expect(await contacts.getParty(northstar, SAM)).toEqual(NOT_FOUND);
    expect(await contacts.getParty(other, keys.pty_REBECCA)).toEqual(NOT_FOUND);
  });

  it('lets viewer, member and owner read and refuses owner,viewer with FORBIDDEN before opening the database (§6.2, P-30)', async () => {
    getWorkspaceDatabase.mockClear();
    const theo = { roles: ['music_supervisor'], organizationName: 'Blue Lantern Studios' };
    for (const role of ['viewer', 'member', 'owner']) {
      expect(await list(withRole(northstar, role))).toHaveLength(14);
      const party = accepted(await contacts.getParty(withRole(northstar, role), keys.pty_THEO));
      expect(party.contact).toMatchObject(theo);
    }
    // Probe: each read asks for the database through the recorded function.
    expect(getWorkspaceDatabase).toHaveBeenCalledTimes(6);
    getWorkspaceDatabase.mockClear();
    const refused = withRole(northstar, 'owner,viewer');
    expect(await contacts.listParties(refused)).toEqual(FORBIDDEN);
    expect(await contacts.getParty(refused, keys.pty_REBECCA)).toEqual(FORBIDDEN);
    expect(getWorkspaceDatabase).not.toHaveBeenCalled();
  });

  it('reads each call in one libSQL batch, one round trip to the workspace database (§1.4)', async () => {
    const { $client } = await connections.getWorkspaceDatabase(northstar.workspaceId);
    const methods = ['batch', 'execute', 'transaction'] as const;
    const spies = methods.map((method) => vi.spyOn($client, method));
    try {
      await contacts.listParties(northstar, { kind: 'organization', query: 'north' });
      await contacts.getParty(northstar, keys.pty_REBECCA);
      expect(spies.map((spy) => spy.mock.calls.length)).toEqual([2, 0, 0]);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it('drops a soft-deleted company, then a soft-deleted contact with its roles, from the list and the detail', async () => {
    const { contacts: contactTable, parties } = tables;
    const database = await connections.getWorkspaceDatabase(northstar.workspaceId);
    const rebecca = async () => (await list(northstar, { query: 'Rebecca' }))[0];
    const detail = async () => accepted(await contacts.getParty(northstar, keys.pty_REBECCA));
    const company = eq(parties.id, keys.pty_CARTER_SYNC);
    const contact = eq(contactTable.id, keys.con_REBECCA);
    await database.update(parties).set({ deletedAt: AT }).where(company);
    try {
      const noCompany = { ...REBECCA.contact, organizationPartyId: null, organizationName: null };
      expect((await rebecca()).contact).toEqual(noCompany);
      expect((await detail()).contact).toEqual(noCompany);
      await database.update(contactTable).set({ deletedAt: AT }).where(contact);
      expect(await rebecca()).toEqual({ ...REBECCA, contact: null });
      expect((await detail()).contact).toBeNull();
    } finally {
      await database.update(parties).set({ deletedAt: null }).where(company);
      await database.update(contactTable).set({ deletedAt: null }).where(contact);
    }
    expect(await rebecca()).toEqual(REBECCA);
  });

  it('lists the primary email, not a newer email that is not primary', async () => {
    const { contactMethods, parties } = tables;
    const database = await connections.getWorkspaceDatabase(other.workspaceId);
    const [partyId, createdAt, updatedAt] = [`pty_${ulid()}`, AT, AT];
    const email = (value: string, isPrimary: number, at: string) => ({
      ...{ id: ulid(), partyId, methodType: 'email', value, isPrimary },
      ...{ createdAt: at, updatedAt: at },
    });
    const party = { id: partyId, partyKind: 'organization', displayName: 'Two Inboxes' };
    // uq_contact_methods_primary allows one primary email per party (§4.3). The other email is
    // written last and sorts last by value, so only the is_primary filter keeps it out.
    await database.batch([
      database.insert(parties).values({ ...party, createdAt, updatedAt }),
      database
        .insert(contactMethods)
        .values([
          email('a-primary@example.test', 1, '2026-09-13T17:00:00.000Z'),
          email('z-other@example.test', 0, '2026-09-14T18:00:00.000Z'),
        ]),
    ]);
    try {
      const organizations = await list(other, { kind: 'organization' });
      expect(organizations).toMatchObject([{ partyId, primaryEmail: 'a-primary@example.test' }]);
    } finally {
      await database.delete(contactMethods).where(eq(contactMethods.partyId, partyId));
      await database.delete(parties).where(eq(parties.id, partyId));
    }
  });
});

describe('melos-rpr.45: organizations list their type and linked people (§4.2, §4.3)', () => {
  const person = (key: string, displayName: string) => ({
    ...{ partyId: keys[`pty_${key}`], displayName },
  });
  const [rebecca, sophia] = [person('REBECCA', 'Rebecca Carter'), person('SOPHIA', 'Sophia Lee')];

  it('lists each organization with its type and the people whose live contact links to it', async () => {
    const organizations = await list(northstar, { kind: 'organization' });
    const listed = organizations.map(({ displayName, organizationType, people }) => [
      ...[displayName, organizationType, people],
    ]);
    expect(listed).toEqual([
      ['Blue Lantern Studios', 'other', [person('THEO', 'Theo Grant')]],
      ['Carter Sync Agency', 'sync_agency', [rebecca]],
      ['NextWave Records', 'label', [person('MALIK', 'Malik Johnson')]],
      ['Nightshift Audio', 'publisher', []],
      ['Northlight Pictures', 'other', [person('MAYA', 'Maya Chen')]],
      ['Northstar Management', 'management', []],
      ['Silverline Songs', 'publisher', []],
    ]);
  });

  it('lists people by name whatever the query, leaving out a soft-deleted contact or person', async () => {
    const { contacts: contactTable, parties } = tables;
    const database = await connections.getWorkspaceDatabase(northstar.workspaceId);
    const carterPeople = async () => (await list(northstar, { query: 'carter sync' }))[0].people;
    const [id, createdAt, updatedAt] = [`con_${ulid()}`, AT, AT];
    const sophiaParty = eq(parties.id, keys.pty_SOPHIA);
    const rebeccaContact = eq(contactTable.id, keys.con_REBECCA);
    // Sophia Lee has no contact in the fixture. This one has no roles, so it is the first contact
    // row (NULL sorts first); only the name order puts her after Rebecca Carter.
    const organizationPartyId = keys.pty_CARTER_SYNC;
    const contact = { id, partyId: keys.pty_SOPHIA, organizationPartyId, createdAt, updatedAt };
    await database.insert(contactTable).values(contact);
    try {
      expect(await carterPeople()).toEqual([rebecca, sophia]);
      await database.update(contactTable).set({ deletedAt: AT }).where(rebeccaContact);
      expect(await carterPeople()).toEqual([sophia]);
      await database.update(parties).set({ deletedAt: AT }).where(sophiaParty);
      expect(await carterPeople()).toEqual([]);
    } finally {
      await database.update(parties).set({ deletedAt: null }).where(sophiaParty);
      await database.update(contactTable).set({ deletedAt: null }).where(rebeccaContact);
      await database.delete(contactTable).where(eq(contactTable.id, id));
    }
    expect(await carterPeople()).toEqual([rebecca]);
  });
});
