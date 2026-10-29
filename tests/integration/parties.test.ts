import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PartyInput } from '../../src/lib/dto/contacts';
import * as tables from '../../src/server/db/schema/workspace.generated';
import type { TenantContext } from '../../src/server/services/tenant-context';
import { catalogSearchOf, NORTHSTAR, seedNorthstarTenant } from './catalog-support';
import { prepareWorkspaceServices, withRole } from './workspace-service';

type Services = Awaited<ReturnType<typeof prepareWorkspaceServices>>;
type Parties = typeof import('../../src/server/services/contacts/parties');

let services: Services;
let service: Parties;
let owner: TenantContext;
const { auditLog, parties } = tables;

const open = (tenant: TenantContext) =>
  services.connections.getWorkspaceDatabase(tenant.workspaceId);
const refused = (error: object) => ({ ok: false, error });
const invalid = (field: string, reason: string) => refused({ code: 'VALIDATION', field, reason });

beforeAll(async () => {
  services = await prepareWorkspaceServices('parties');
  service = await import('../../src/server/services/contacts/parties');
  owner = await seedNorthstarTenant();
});

afterAll(async () => {
  if (owner) await services.connections.closeWorkspaceDatabase(owner.workspaceId);
  await services?.close();
});

/** The audit rows for one party, oldest first, with their JSON parsed. */
async function auditOf(entityId: string) {
  const rows = await (await open(owner))
    .select()
    .from(auditLog)
    .where(eq(auditLog.entityId, entityId));
  return rows.map(({ action, beforeJson, afterJson }) => ({
    ...{ action, before: beforeJson && JSON.parse(beforeJson) },
    after: afterJson && JSON.parse(afterJson),
  }));
}

/** catalog_search equals validate.mjs's derivation and every foreign key holds. */
async function consistent() {
  const database = await open(owner);
  const search = await catalogSearchOf(database);
  expect(search.indexed).toEqual(search.derived);
  expect(await database.all(sql`PRAGMA foreign_key_check`)).toEqual([]);
}

async function created(input: PartyInput) {
  const result = await service.createParty(owner, input);
  if (!result.ok) throw new Error(`Refused with ${result.error.code}`);
  return result.value;
}

describe('melos-rpr.20: createParty, updateParty and deleteParty (§4.2, D-5)', () => {
  it('creates a person and an organization with their subtype rows and audits each', async () => {
    const person = await created({
      ...{ partyKind: 'person', displayName: ' Ana Ruiz ' },
      person: { givenName: 'Ana', familyName: 'Ruiz' },
    });
    expect(person).toMatchObject({
      partyKind: 'person',
      displayName: 'Ana Ruiz',
      organization: null,
    });
    expect(person.person).toEqual({ givenName: 'Ana', familyName: 'Ruiz', legalName: 'Ana Ruiz' });
    const label = await created({
      ...{ partyKind: 'organization', displayName: 'Lantern Sync', notes: 'Agency' },
      organization: { legalName: 'Lantern Sync LLC', websiteUrl: 'https://lantern.example' },
    });
    expect(label.organization).toEqual({
      ...{ legalName: 'Lantern Sync LLC', organizationType: null },
      websiteUrl: 'https://lantern.example',
    });
    const [audit, ...more] = await auditOf(label.partyId);
    expect(more).toEqual([]);
    expect(audit).toMatchObject({ action: 'party.create', before: null });
    expect(audit.after.organization.legalName).toBe('Lantern Sync LLC');
    await consistent();
  });

  it('refuses bad fields before the database opens, and a viewer outright', async () => {
    const [before] = await (await open(owner)).all(sql`SELECT count(*) AS n FROM parties`);
    services.getWorkspaceDatabase.mockClear();
    const cases: [PartyInput, object][] = [
      [{ partyKind: 'band' as never, displayName: 'A' }, invalid('partyKind', 'unknown_kind')],
      [{ partyKind: 'person', displayName: ' ' }, invalid('displayName', 'required')],
      [
        { partyKind: 'person', displayName: 'A', person: { legalName: ' ' } },
        invalid('legalName', 'required'),
      ],
    ];
    for (const [input, refusal] of cases)
      expect(await service.createParty(owner, input), JSON.stringify(input)).toEqual(refusal);
    const viewer = withRole(owner, 'viewer');
    const forbidden = refused({ code: 'FORBIDDEN' });
    expect(await service.createParty(viewer, { partyKind: 'person', displayName: 'A' })).toEqual(
      forbidden,
    );
    expect(await service.updateParty(viewer, NORTHSTAR.keys.pty_ALEX, {})).toEqual(forbidden);
    expect(await service.deleteParty(withRole(owner, 'member'), NORTHSTAR.keys.pty_ALEX)).toEqual(
      forbidden,
    );
    expect(services.getWorkspaceDatabase).not.toHaveBeenCalled();
    expect(await (await open(owner)).all(sql`SELECT count(*) AS n FROM parties`)).toEqual([before]);
  });

  it('refuses a kind change while a kind-checked row holds the party, and allows it otherwise', async () => {
    const jordan = NORTHSTAR.keys.pty_JORDAN;
    const change = await service.updateParty(owner, jordan, { partyKind: 'organization' });
    expect(change).toMatchObject(refused({ code: 'REFERENCED' }));
    if (change.ok || change.error.code !== 'REFERENCED') throw new Error('Not refused');
    expect(Object.keys(change.error.counts).length).toBeGreaterThan(0);
    const free = await created({ partyKind: 'person', displayName: 'Kai Moss' });
    const moved = await service.updateParty(owner, free.partyId, {
      ...{ partyKind: 'organization', displayName: 'Kai Moss Music' },
      organization: { organizationType: 'publisher' },
    });
    if (!moved.ok) throw new Error(`Refused with ${moved.error.code}`);
    expect(moved.value).toMatchObject({ partyKind: 'organization', person: null });
    expect(moved.value.organization).toEqual({
      ...{ legalName: 'Kai Moss Music', organizationType: 'publisher', websiteUrl: null },
    });
    await consistent();
  });

  it('reindexes the songs that credit a renamed party, and a no-op patch writes nothing', async () => {
    const alex = NORTHSTAR.keys.pty_ALEX;
    const renamed = await service.updateParty(owner, alex, { displayName: 'Alex Ramírez Cruz' });
    if (!renamed.ok) throw new Error(`Refused with ${renamed.error.code}`);
    expect(renamed.value.displayName).toBe('Alex Ramírez Cruz');
    const search = await catalogSearchOf(await open(owner));
    expect(JSON.stringify(search.indexed)).toContain('Alex Ramírez Cruz');
    await consistent();
    const audits = (await auditOf(alex)).length;
    const same = await service.updateParty(owner, alex, { displayName: 'Alex Ramírez Cruz' });
    expect(same.ok).toBe(true);
    expect(await auditOf(alex)).toHaveLength(audits);
  });

  it('soft-deletes an unreferenced party and refuses one a share still references', async () => {
    const silverline = await service.deleteParty(owner, NORTHSTAR.keys.pty_SILVERLINE);
    expect(silverline).toMatchObject(refused({ code: 'REFERENCED' }));
    const spare = await created({ partyKind: 'person', displayName: 'Spare Part' });
    expect(await service.deleteParty(owner, spare.partyId)).toEqual({
      ok: true,
      value: { partyId: spare.partyId },
    });
    const [row] = await (await open(owner))
      .select()
      .from(parties)
      .where(eq(parties.id, spare.partyId));
    expect(row.deletedAt).not.toBeNull();
    expect((await auditOf(spare.partyId)).map((a) => a.action)).toEqual([
      'party.create',
      'party.delete',
    ]);
    expect(await service.deleteParty(owner, spare.partyId)).toEqual(refused({ code: 'NOT_FOUND' }));
    await consistent();
  });

  it("answers NOT_FOUND for another workspace's party", async () => {
    const other = await services.provision('owner');
    const alex = NORTHSTAR.keys.pty_ALEX;
    const notFound = refused({ code: 'NOT_FOUND' });
    expect(await service.updateParty(other, alex, { displayName: 'X' })).toEqual(notFound);
    expect(await service.deleteParty(other, alex)).toEqual(notFound);
  });
});
