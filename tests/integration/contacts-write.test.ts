import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as tables from '../../src/server/db/schema/workspace.generated';
import type { TenantContext } from '../../src/server/services/tenant-context';
import { NORTHSTAR, seedNorthstarTenant } from './catalog-support';
import { prepareWorkspaceServices, withRole } from './workspace-service';

type Services = Awaited<ReturnType<typeof prepareWorkspaceServices>>;
type Contacts = typeof import('../../src/server/services/contacts/contacts');

let services: Services;
let service: Contacts;
let owner: TenantContext;
const { auditLog, contacts } = tables;
const { pty_REBECCA: REBECCA, pty_CARTER_SYNC: CARTER, pty_ALEX: ALEX } = NORTHSTAR.keys;
const { con_THEO: THEO, con_MALIK: MALIK } = NORTHSTAR.keys;

const open = (tenant: TenantContext) =>
  services.connections.getWorkspaceDatabase(tenant.workspaceId);
const refused = (error: object) => ({ ok: false, error });

beforeAll(async () => {
  services = await prepareWorkspaceServices('contacts-write');
  service = await import('../../src/server/services/contacts/contacts');
  owner = await seedNorthstarTenant();
});

afterAll(async () => {
  if (owner) await services.connections.closeWorkspaceDatabase(owner.workspaceId);
  await services?.close();
});

const auditCount = async () =>
  (await (await open(owner)).all<{ n: number }>(sql`SELECT count(*) AS n FROM audit_log`))[0].n;
const noForeignKeyErrors = async () =>
  expect(await (await open(owner)).all(sql`PRAGMA foreign_key_check`)).toEqual([]);

describe('melos-rpr.27: createContact, updateContact and deleteContact (CRM-001, P-09)', () => {
  it('creates a new party and its contact in one call, writing 2 audit rows', async () => {
    const audits = await auditCount();
    const created = await service.createContact(owner, {
      party: { partyKind: 'person', displayName: 'Dana Wells' },
      ...{ organizationPartyId: CARTER, roles: [' music_supervisor ', 'music_supervisor'] },
    });
    if (!created.ok) throw new Error(`Refused with ${JSON.stringify(created.error)}`);
    expect(created.value).toMatchObject({
      ...{ displayName: 'Dana Wells', organizationPartyId: CARTER, roles: ['music_supervisor'] },
      ...{ active: true, pitchItems: [], recentMessages: [] },
    });
    expect(await auditCount()).toBe(audits + 2);
    const rows = await (await open(owner))
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityId, created.value.contactId));
    expect(rows.map((row) => row.action)).toEqual(['contact.create']);
    await noForeignKeyErrors();
  });

  it('refuses a second contact for Rebecca Carter, a person as company and bad input', async () => {
    const audits = await auditCount();
    const cases: [Parameters<Contacts['createContact']>[1], object][] = [
      [{ partyId: REBECCA }, refused({ code: 'CONFLICT', field: 'partyId' })],
      [
        { partyId: ALEX, organizationPartyId: REBECCA },
        refused({
          code: 'VALIDATION',
          field: 'organizationPartyId',
          reason: 'organization_required',
        }),
      ],
      [
        {},
        refused({
          code: 'VALIDATION',
          field: 'partyId',
          reason: 'exactly_one_of_party_or_party_id',
        }),
      ],
      [{ partyId: 'pty_missing' }, refused({ code: 'NOT_FOUND' })],
      [
        { partyId: ALEX, roles: [' '] },
        refused({ code: 'VALIDATION', field: 'roles', reason: 'required' }),
      ],
    ];
    for (const [input, refusal] of cases)
      expect(await service.createContact(owner, input), JSON.stringify(input)).toEqual(refusal);
    expect(await auditCount()).toBe(audits);
    await noForeignKeyErrors();
  });

  it('updates roles and notes once, and a no-op writes nothing', async () => {
    const updated = await service.updateContact(withRole(owner, 'member'), MALIK, {
      ...{ roles: ['a_and_r', 'label'], relationshipNotes: 'Met at ADE' },
    });
    if (!updated.ok) throw new Error(`Refused with ${JSON.stringify(updated.error)}`);
    expect(updated.value).toMatchObject({
      roles: ['a_and_r', 'label'],
      relationshipNotes: 'Met at ADE',
    });
    const audits = await auditCount();
    expect((await service.updateContact(owner, MALIK, { roles: ['label', 'a_and_r'] })).ok).toBe(
      true,
    );
    expect(await auditCount()).toBe(audits);
    await noForeignKeyErrors();
  });

  it('refuses deleting a pitched contact and a member, and deletes an unpitched one', async () => {
    const theo = await service.deleteContact(owner, THEO);
    if (theo.ok || theo.error.code !== 'REFERENCED') throw new Error('Not refused');
    expect(Object.keys(theo.error.counts)).toContain('pitches');
    services.getWorkspaceDatabase.mockClear();
    expect(await service.deleteContact(withRole(owner, 'member'), MALIK)).toEqual(
      refused({ code: 'FORBIDDEN' }),
    );
    expect(services.getWorkspaceDatabase).not.toHaveBeenCalled();
    const fresh = await service.createContact(owner, { partyId: ALEX });
    if (!fresh.ok) throw new Error('Not created');
    expect(await service.deleteContact(owner, fresh.value.contactId)).toEqual({
      ok: true,
      value: { contactId: fresh.value.contactId },
    });
    const [row] = await (await open(owner))
      .select()
      .from(contacts)
      .where(eq(contacts.id, fresh.value.contactId));
    expect(row.deletedAt).not.toBeNull();
    expect(await service.getContact(owner, fresh.value.contactId)).toEqual(
      refused({ code: 'NOT_FOUND' }),
    );
    const other = await services.provision('owner');
    expect(await service.updateContact(other, MALIK, { active: false })).toEqual(
      refused({ code: 'NOT_FOUND' }),
    );
    await noForeignKeyErrors();
  });
});
