import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ContactMethodInput } from '../../src/lib/dto/contacts';
import * as tables from '../../src/server/db/schema/workspace.generated';
import type { TenantContext } from '../../src/server/services/tenant-context';
import { NORTHSTAR, seedNorthstarTenant } from './catalog-support';
import { prepareWorkspaceServices, withRole } from './workspace-service';

type Services = Awaited<ReturnType<typeof prepareWorkspaceServices>>;
type Methods = typeof import('../../src/server/services/contacts/methods');

let services: Services;
let service: Methods;
let owner: TenantContext;
const { auditLog, messageRecipients } = tables;
const JORDAN = NORTHSTAR.keys.pty_JORDAN;
const [EMAIL, PHONE] = [
  NORTHSTAR.keys['contact_methods:JORDAN_EMAIL'],
  NORTHSTAR.keys['contact_methods:JORDAN_PHONE'],
];

const open = (tenant: TenantContext) =>
  services.connections.getWorkspaceDatabase(tenant.workspaceId);
const refused = (error: object) => ({ ok: false, error });
const invalid = (reason: string) => refused({ code: 'VALIDATION', field: 'methods', reason });

beforeAll(async () => {
  services = await prepareWorkspaceServices('contact-methods');
  service = await import('../../src/server/services/contacts/methods');
  owner = await seedNorthstarTenant();
});

afterAll(async () => {
  if (owner) await services.connections.closeWorkspaceDatabase(owner.workspaceId);
  await services?.close();
});

const auditsOf = async (entityId: string) =>
  (await open(owner)).select().from(auditLog).where(eq(auditLog.entityId, entityId));

async function noForeignKeyErrors() {
  expect(await (await open(owner)).all(sql`PRAGMA foreign_key_check`)).toEqual([]);
}

describe('melos-rpr.20: setContactMethods and findMatchingParties (§4.2, §6.15)', () => {
  it('replaces the set, keeps rows by id, moves the primary and audits once', async () => {
    const methods: ContactMethodInput[] = [
      { id: EMAIL, methodType: 'email', value: 'jordan@silverline.example', label: 'work' },
      { methodType: 'email', value: ' Jordan@Northstar.Example ', isPrimary: true },
      { methodType: 'url', value: 'https://jordantaylor.example' },
    ];
    const audits = (await auditsOf(JORDAN)).length;
    const set = await service.setContactMethods(owner, JORDAN, methods);
    if (!set.ok) throw new Error(`Refused with ${set.error.code}`);
    expect(set.value.methods.map((m) => [m.methodType, m.value, m.isPrimary])).toEqual([
      ['email', 'jordan@northstar.example', true],
      ['email', 'jordan@silverline.example', false],
      ['url', 'https://jordantaylor.example', false],
    ]);
    expect(set.value.methods.find((m) => m.value.startsWith('jordan@silver'))?.id).toBe(EMAIL);
    const rows = await auditsOf(JORDAN);
    expect(rows).toHaveLength(audits + 1);
    const audit = rows.at(-1);
    expect(audit).toMatchObject({ action: 'party.update', actorUserId: owner.userId });
    expect(JSON.parse(audit?.beforeJson ?? '{}').methods).toHaveLength(2);
    expect(JSON.parse(audit?.afterJson ?? '{}').methods).toHaveLength(3);
    await noForeignKeyErrors();
    // The same set again changes nothing and writes nothing.
    const again = set.value.methods.map(({ id, methodType, value, label, isPrimary }) => ({
      ...{ id, methodType: methodType as ContactMethodInput['methodType'] },
      ...{ value, label, isPrimary },
    }));
    expect((await service.setContactMethods(owner, JORDAN, again)).ok).toBe(true);
    expect(await auditsOf(JORDAN)).toHaveLength(audits + 1);
  });

  it('unlinks a removed method from messages and keeps their address snapshot', async () => {
    const database = await open(owner);
    // The phone was removed by the first test; the messages it never named are untouched.
    const named = eq(messageRecipients.contactMethodId, PHONE);
    expect(await database.select().from(messageRecipients).where(named)).toEqual([]);
    const set = await service.setContactMethods(owner, JORDAN, []);
    expect(set.ok && set.value.methods).toEqual([]);
    const snapshot = eq(messageRecipients.addressSnapshot, 'jordan@silverline.example');
    const recipients = await database.select().from(messageRecipients).where(snapshot);
    expect(recipients.length).toBeGreaterThan(0);
    expect(recipients.every((row) => row.contactMethodId === null)).toBe(true);
    await noForeignKeyErrors();
  });

  it('refuses before writing: bad methods, two primaries of a type, a foreign id', async () => {
    const alex = NORTHSTAR.keys.pty_ALEX;
    const audits = (await auditsOf(alex)).length;
    const primary = { methodType: 'phone', value: '+1 555', isPrimary: true } as const;
    const cases: [ContactMethodInput[], object][] = [
      [[{ methodType: 'fax' as never, value: '1' }], invalid('unknown_method_type')],
      [[{ methodType: 'email', value: ' ' }], invalid('required')],
      [[primary, primary], invalid('more_than_one_primary')],
      [[{ id: EMAIL, methodType: 'email', value: 'a@b.example' }], refused({ code: 'NOT_FOUND' })],
    ];
    for (const [methods, refusal] of cases)
      expect(await service.setContactMethods(owner, alex, methods)).toEqual(refusal);
    expect(await auditsOf(alex)).toHaveLength(audits);
    const other = await services.provision('owner');
    expect(await service.setContactMethods(other, alex, [])).toEqual(
      refused({ code: 'NOT_FOUND' }),
    );
    services.getWorkspaceDatabase.mockClear();
    const viewer = withRole(owner, 'viewer');
    expect(await service.setContactMethods(viewer, alex, [])).toEqual(
      refused({ code: 'FORBIDDEN' }),
    );
    expect(services.getWorkspaceDatabase).not.toHaveBeenCalled();
    await noForeignKeyErrors();
  });

  it('finds live parties by normalized name or by email, case-insensitively', async () => {
    const found = await service.findMatchingParties(owner, {
      ...{ displayName: '  alex   RAMIREZ ', email: 'ALEX@Nightshift.example' },
    });
    if (!found.ok) throw new Error(`Refused with ${found.error.code}`);
    expect(found.value).toEqual([
      {
        ...{ partyId: NORTHSTAR.keys.pty_ALEX, partyKind: 'person', displayName: 'Alex Ramirez' },
        matchedOn: ['name', 'email'],
      },
    ]);
    expect(await service.findMatchingParties(owner, {})).toEqual({ ok: true, value: [] });
    const viewer = withRole(owner, 'viewer');
    expect((await service.findMatchingParties(viewer, { displayName: 'Alex Ramirez' })).ok).toBe(
      true,
    );
  });
});
