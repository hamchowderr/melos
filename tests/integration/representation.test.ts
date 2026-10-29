import { readFileSync } from 'node:fs';
import { eq, sql } from 'drizzle-orm';
import { ulid } from 'ulid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RightsSummaryDTO } from '../../src/lib/dto/rights';
import * as tables from '../../src/server/db/schema/workspace.generated';
import type { ServiceResult } from '../../src/server/services/service-result';
import type { TenantContext } from '../../src/server/services/tenant-context';
import { prepareWorkspaceServices, withRole } from './workspace-service';

const fixture = JSON.parse(readFileSync('docs/fixtures/northstar-demo.json', 'utf8'));
const { keys } = fixture as { keys: Record<string, string> };
const OCEAN_NIGHTSHIFT = keys['publishing_interests:OCEAN_NIGHTSHIFT_WORLD'];
const MIDNIGHT_MASTER = keys['master_interests:MIDNIGHT_SILVERLINE'];
const refused = (error: object) => ({ ok: false, error });
const [FORBIDDEN, NOT_FOUND] = [refused({ code: 'FORBIDDEN' }), refused({ code: 'NOT_FOUND' })];
const invalid = (field: string, reason: string) => refused({ code: 'VALIDATION', field, reason });
let services: Awaited<ReturnType<typeof prepareWorkspaceServices>>;
let service: typeof import('../../src/server/services/rights/representation');
let owner: TenantContext;
let other: TenantContext;
let agreementId: string;

async function accepted<T>(pending: Promise<ServiceResult<T>>): Promise<T> {
  const result = await pending;
  if (!result.ok) throw new Error(`Refused with ${JSON.stringify(result.error)}`);
  return result.value;
}
const open = () => services.connections.getWorkspaceDatabase(owner.workspaceId);
/** Audit rows, once PRAGMA foreign_key_check is empty (DAT-INT-001). */
async function audits() {
  const database = await open();
  expect(await database.all(sql`PRAGMA foreign_key_check`)).toEqual([]);
  return database.select().from(tables.auditLog);
}
const holder = (summary: RightsSummaryDTO, interestId: string) =>
  [
    ...summary.publishing.flatMap((p) => p.holders),
    ...summary.masters.flatMap((m) => m.holders),
  ].find((h) => h.interestId === interestId);
const codes = (summary: RightsSummaryDTO) => summary.issues.map(({ code }) => code);

beforeAll(async () => {
  services = await prepareWorkspaceServices('representation');
  service = await import('../../src/server/services/rights/representation');
  const { seedNorthstar } = await import('../../src/server/db/seed/northstar');
  const seeded = await seedNorthstar({
    password: 'representation-password',
    seedDate: fixture.demo.date,
  });
  if (seeded.status !== 'seeded') throw new Error(`Northstar was ${seeded.status}`);
  const ids = { userId: keys.usr_JORDAN, requestId: crypto.randomUUID() };
  owner = {
    ...ids,
    organizationId: seeded.organizationId,
    workspaceId: seeded.workspaceId,
    workspaceRole: 'owner',
  };
  other = await services.provision('owner');
  const { createAgreement } = await import('../../src/server/services/rights/agreements');
  const agreement = { agreementType: 'representation' as const, title: 'Nightshift admin' };
  ({ id: agreementId } = await accepted(
    createAgreement(owner, { ...agreement, counterpartyPartyId: keys.pty_NIGHTSHIFT }),
  ));
});

afterAll(async () => {
  if (owner) await services.connections.closeWorkspaceDatabase(owner.workspaceId);
  await services?.close();
});

describe('RGT-INT-006: attestRepresentation', () => {
  it('attests Nightshift on Ocean Blue with an agreement, which leaves PUBLISHING_NOT_CONTROLLED at 8500, then clears both', async () => {
    const earlier = (await audits()).length;
    const input = { interestType: 'publishing' as const, interestId: OCEAN_NIGHTSHIFT };
    const attested = await accepted(
      service.attestRepresentation(owner, { ...input, agreementId, attested: true }),
    );
    expect(holder(attested, OCEAN_NIGHTSHIFT)).toMatchObject({
      representationAttested: true,
      agreementId,
    });
    expect(attested.publishing.map((p) => p.totalBp)).toEqual([8500]);
    expect(codes(attested)).toContain('PUBLISHING_NOT_CONTROLLED');
    // Again, unchanged: no write and no audit row.
    await accepted(service.attestRepresentation(owner, { ...input, attested: true }));
    const cleared = await accepted(
      service.attestRepresentation(owner, { ...input, attested: false }),
    );
    expect(holder(cleared, OCEAN_NIGHTSHIFT)).toMatchObject({
      representationAttested: false,
      agreementId: null,
    });
    const rows = (await audits()).slice(earlier);
    expect(rows.map((r) => r.action)).toEqual(['representation.attest', 'representation.clear']);
    const [attest, clear] = rows;
    expect(attest).toMatchObject({
      actorUserId: owner.userId,
      requestId: owner.requestId,
      entityType: 'publishing_interest',
      entityId: OCEAN_NIGHTSHIFT,
    });
    expect(JSON.parse(attest.afterJson ?? '')).toMatchObject({
      agreementId,
      representationAttestedBy: owner.userId,
    });
    expect(JSON.parse(clear.afterJson ?? '')).toMatchObject({
      agreementId: null,
      representationAttestedAt: null,
      representationAttestedBy: null,
    });
  });

  it('refuses before writing: a viewer, a bad type, a missing, foreign or deleted interest, a missing agreement', async () => {
    const earlier = (await audits()).length;
    services.getWorkspaceDatabase.mockClear();
    const base = { interestType: 'master' as const, interestId: MIDNIGHT_MASTER, attested: true };
    expect(await service.attestRepresentation(withRole(owner, 'viewer'), base)).toEqual(FORBIDDEN);
    expect(
      await service.attestRepresentation(owner, { ...base, interestType: 'writer' as 'master' }),
    ).toEqual(invalid('interestType', 'not_allowed'));
    expect(services.getWorkspaceDatabase).not.toHaveBeenCalled();
    expect(
      await service.attestRepresentation(owner, { ...base, interestId: `mst_${ulid()}` }),
    ).toEqual(NOT_FOUND);
    expect(await service.attestRepresentation(other, base)).toEqual(NOT_FOUND);
    expect(
      await service.attestRepresentation(owner, { ...base, agreementId: `agr_${ulid()}` }),
    ).toEqual(refused({ code: 'NOT_FOUND', counts: { agreements: 1 } }));
    expect(await service.attestRepresentation(withRole(owner, 'member'), base)).toMatchObject({
      ok: true,
    });
    expect((await audits()).length).toBe(earlier + 1);
  });
});

describe('RGT-005: updateLicensingContacts', () => {
  it('replaces the implicit contact on Midnight Drive with an explicit one, then edits and empties the set', async () => {
    const earlier = (await audits()).length;
    const target = { recordingId: keys.rec_MIDNIGHT };
    const before = await accepted(
      service.updateLicensingContacts(owner, { ...target, contacts: [] }),
    );
    expect(before.licensingContacts).toEqual([
      { partyId: keys.pty_SILVERLINE, displayName: expect.any(String), implicit: true },
    ]);
    const explicit = await accepted(
      service.updateLicensingContacts(owner, {
        ...target,
        contacts: [{ partyId: keys.pty_REBECCA, agreementId }],
      }),
    );
    expect(explicit.licensingContacts).toEqual([
      { partyId: keys.pty_REBECCA, displayName: expect.any(String), implicit: false },
    ]);
    const database = await open();
    const [row] = await database
      .select()
      .from(tables.licensingContacts)
      .where(eq(tables.licensingContacts.partyId, keys.pty_REBECCA));
    // Kept by party: a note changes the row, not its id.
    await accepted(
      service.updateLicensingContacts(owner, {
        ...target,
        contacts: [{ partyId: keys.pty_REBECCA, agreementId, notes: 'Sync only' }],
      }),
    );
    const [edited] = await database
      .select()
      .from(tables.licensingContacts)
      .where(eq(tables.licensingContacts.id, row.id));
    expect(edited).toMatchObject({ notes: 'Sync only', createdAt: row.createdAt });
    await accepted(service.updateLicensingContacts(owner, { ...target, contacts: [] }));
    const rows = (await audits()).slice(earlier);
    expect(rows.map((r) => [r.action, r.entityType, r.entityId])).toEqual(
      Array(3).fill(['licensing_contacts.replace', 'recording', keys.rec_MIDNIGHT]),
    );
    expect(JSON.parse(rows[2].beforeJson ?? '').contacts).toHaveLength(1);
    expect(JSON.parse(rows[2].afterJson ?? '')).toEqual({ contacts: [] });
  });

  it('sets a contact on a composition, which Ocean Blue reads, and refuses bad input before writing', async () => {
    const earlier = (await audits()).length;
    const summary = await accepted(
      service.updateLicensingContacts(owner, {
        compositionId: keys.cmp_OCEAN,
        contacts: [{ partyId: keys.pty_ALEX }],
      }),
    );
    expect(codes(summary)).not.toContain('NO_LICENSING_CONTACT');
    const contacts = [{ partyId: keys.pty_ALEX }];
    expect(await service.updateLicensingContacts(owner, { contacts })).toEqual(
      invalid('target', 'exactly_one'),
    );
    expect(
      await service.updateLicensingContacts(owner, {
        recordingId: keys.rec_OCEAN,
        compositionId: keys.cmp_OCEAN,
        contacts,
      }),
    ).toEqual(invalid('target', 'exactly_one'));
    expect(
      await service.updateLicensingContacts(owner, {
        recordingId: keys.rec_OCEAN,
        contacts: [...contacts, ...contacts],
      }),
    ).toEqual(invalid('contacts', 'duplicate_party'));
    expect(
      await service.updateLicensingContacts(withRole(owner, 'viewer'), {
        recordingId: keys.rec_OCEAN,
        contacts,
      }),
    ).toEqual(FORBIDDEN);
    expect(
      await service.updateLicensingContacts(owner, { recordingId: `rec_${ulid()}`, contacts }),
    ).toEqual(NOT_FOUND);
    expect(
      await service.updateLicensingContacts(other, { recordingId: keys.rec_OCEAN, contacts }),
    ).toEqual(NOT_FOUND);
    expect(
      await service.updateLicensingContacts(owner, {
        recordingId: keys.rec_OCEAN,
        contacts: [{ partyId: `pty_${ulid()}` }],
      }),
    ).toEqual(refused({ code: 'NOT_FOUND', counts: { parties: 1 } }));
    expect((await audits()).length).toBe(earlier + 1);
  });
});
