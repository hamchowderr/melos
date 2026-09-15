import { eq, sql } from 'drizzle-orm';
import { ulid } from 'ulid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgreementFilter, AgreementInput, AgreementType } from '../../src/lib/dto/rights';
import { agreements, auditLog, parties } from '../../src/server/db/schema/workspace.generated';
import { canonicalJson } from '../../src/server/services/audit-writer';
import type { ServiceResult } from '../../src/server/services/service-result';
import type { TenantContext } from '../../src/server/services/tenant-context';
import { prepareWorkspaceServices, withRole } from './workspace-service';

type Services = Awaited<ReturnType<typeof prepareWorkspaceServices>>;
type Agreements = typeof import('../../src/server/services/rights/agreements');

const AT = '2026-09-15T12:00:00.000Z';
/** Parties in the first workspace: Silverline Songs, and one that is soft-deleted. */
const [SILVERLINE, GONE] = [`pty_${ulid()}`, `pty_${ulid()}`];
const refused = (error: object) => ({ ok: false, error });
const [FORBIDDEN, NOT_FOUND] = [refused({ code: 'FORBIDDEN' }), refused({ code: 'NOT_FOUND' })];
const NO_PARTY = refused({ code: 'NOT_FOUND', counts: { parties: 1 } });
const invalid = (field: string, reason: string) => refused({ code: 'VALIDATION', field, reason });
const DEAL = { agreementType: 'publishing', title: 'Admin deal' } as const;
let services: Services;
let service: Agreements;
let owner: TenantContext;
let other: TenantContext;

function accepted<T>(result: ServiceResult<T>): T {
  if (!result.ok) throw new Error(`Refused with ${result.error.code}`);
  return result.value;
}
const open = (tenant: TenantContext) =>
  services.connections.getWorkspaceDatabase(tenant.workspaceId);
const stored = async (tenant: TenantContext, id: string) =>
  (await open(tenant)).select().from(agreements).where(eq(agreements.id, id));
/** The tenant's audit rows, after asserting PRAGMA foreign_key_check is empty (DAT-INT-001). */
async function audited(tenant: TenantContext) {
  const database = await open(tenant);
  expect(await database.all(sql`PRAGMA foreign_key_check`)).toEqual([]);
  return database.select().from(auditLog);
}

beforeAll(async () => {
  services = await prepareWorkspaceServices('agreements');
  service = await import('../../src/server/services/rights/agreements');
  [owner, other] = [await services.provision('owner'), await services.provision('owner')];
  const party = (id: string, displayName: string, deletedAt: string | null) => ({
    ...{ id, partyKind: 'organization', displayName, deletedAt, createdAt: AT, updatedAt: AT },
  });
  await (await open(owner))
    .insert(parties)
    .values([party(SILVERLINE, 'Silverline Songs', null), party(GONE, 'Gone Music', AT)]);
});

afterAll(() => services?.close());

describe('melos-rpr.15: agreements that back publishing, master and licensing rows (RGT-006)', () => {
  it('lets owner, admin and member write; viewer and owner,viewer get FORBIDDEN before the database opens (§6.2, D-5)', async () => {
    let id = '';
    services.getWorkspaceDatabase.mockClear();
    for (const role of ['owner', 'admin', 'member']) {
      const tenant = withRole(owner, role);
      id = accepted(await service.createAgreement(tenant, DEAL)).id;
      const updated = await service.updateAgreement(tenant, id, { notes: role });
      expect(updated, role).toMatchObject({ ok: true, value: { id, notes: role } });
    }
    expect(services.getWorkspaceDatabase).toHaveBeenCalledTimes(6);
    await audited(owner);
    services.getWorkspaceDatabase.mockClear();
    for (const role of ['viewer', 'owner,viewer']) {
      const tenant = withRole(owner, role);
      expect(await service.createAgreement(tenant, DEAL), role).toEqual(FORBIDDEN);
      // The permission comes before validation.
      expect(await service.createAgreement(tenant, { ...DEAL, title: '' })).toEqual(FORBIDDEN);
      expect(await service.updateAgreement(tenant, id, { notes: role })).toEqual(FORBIDDEN);
    }
    expect(await service.listAgreements(withRole(owner, 'owner,viewer'))).toEqual(FORBIDDEN);
    expect(services.getWorkspaceDatabase.mock.calls).toEqual([]);
    expect((await stored(owner, id))[0].notes).toBe('member');
  });

  it('audits each create and update once with actor, request id and the full row before and after (AUD-INT-001, D-4)', async () => {
    const earlier = (await audited(owner)).length;
    const input = {
      agreementType: 'representation' as AgreementType,
      title: '  Silverline representation ',
      ...{ counterpartyPartyId: SILVERLINE, effectiveOn: '2026-01-01', expiresOn: '2028-12-31' },
      notes: 'Side deal in Personal Notes',
    };
    const created = accepted(await service.createAgreement(owner, input));
    const [row] = await stored(owner, created.id);
    const by = { createdBy: owner.userId, updatedBy: owner.userId, createdAt: row.updatedAt };
    const fixed = { title: 'Silverline representation', assetId: null, updatedAt: row.updatedAt };
    expect(row).toEqual({ ...input, ...by, ...fixed, id: created.id });
    expect(row.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(created).toEqual({ ...row, counterpartyName: 'Silverline Songs' });

    const patch = { expiresOn: null, notes: null };
    const updated = accepted(await service.updateAgreement(owner, created.id, patch));
    const [after] = await stored(owner, created.id);
    expect(after).toEqual({ ...row, ...patch, updatedAt: after.updatedAt });
    expect(updated).toEqual({ ...after, counterpartyName: 'Silverline Songs' });
    const entry = {
      ...{ actorType: 'user', actorUserId: owner.userId, requestId: owner.requestId },
      ...{ entityType: 'agreement', entityId: created.id },
    };
    const [before, now] = [canonicalJson(row), canonicalJson(after)];
    expect((await audited(owner)).slice(earlier)).toMatchObject([
      { ...entry, action: 'agreement.create', beforeJson: null, afterJson: before },
      { ...entry, action: 'agreement.update', beforeJson: before, afterJson: now },
    ]);
  });

  it('refuses a missing or deleted counterparty with NOT_FOUND and broken fields with VALIDATION, writing nothing', async () => {
    const later = { ...DEAL, effectiveOn: '2026-05-01' };
    const kept = accepted(await service.createAgreement(owner, later));
    const rows = await stored(owner, kept.id);
    const earlier = await audited(owner);
    for (const counterpartyPartyId of [`pty_${ulid()}`, GONE]) {
      const created = await service.createAgreement(owner, { ...DEAL, counterpartyPartyId });
      expect(created).toEqual(NO_PARTY);
    }
    const moved = await service.updateAgreement(owner, kept.id, { counterpartyPartyId: GONE });
    expect(moved).toEqual(NO_PARTY);
    // The stored effectiveOn is 2026-05-01; the patch would expire the day before.
    const early = await service.updateAgreement(owner, kept.id, { expiresOn: '2026-04-30' });
    expect(early).toEqual(invalid('expiresOn', 'expires_before_effective'));
    const unknown = await service.updateAgreement(owner, `agr_${ulid()}`, { notes: 'x' });
    expect(unknown).toEqual(NOT_FOUND);

    services.getWorkspaceDatabase.mockClear();
    const cases = [
      [
        { effectiveOn: '2026-05-01', expiresOn: '2026-04-30' },
        'expiresOn',
        'expires_before_effective',
      ],
      [{ agreementType: 'sync' as AgreementType }, 'agreementType', 'not_allowed'],
      [{ title: '   ' }, 'title', 'required'],
      [{ effectiveOn: '2026-02-30' }, 'effectiveOn', 'not_a_date'],
    ] as const;
    for (const [fields, field, reason] of cases) {
      const refusal = invalid(field, reason);
      expect(await service.createAgreement(owner, { ...DEAL, ...fields })).toEqual(refusal);
      expect(await service.updateAgreement(owner, kept.id, fields)).toEqual(refusal);
    }
    // These checks need no stored row, so they never open the database.
    expect(services.getWorkspaceDatabase.mock.calls).toEqual([]);
    expect([await stored(owner, kept.id), await audited(owner)]).toEqual([rows, earlier]);
  });

  it('never resolves an id from another workspace: its agreement and its counterparty are NOT_FOUND (TEN-001)', async () => {
    const mine = { ...DEAL, counterpartyPartyId: SILVERLINE };
    const { id } = accepted(await service.createAgreement(owner, mine));
    expect(await service.updateAgreement(other, id, { notes: 'x' })).toEqual(NOT_FOUND);
    expect(await service.createAgreement(other, mine)).toEqual(NO_PARTY);
    expect(await service.listAgreements(other)).toEqual({ ok: true, value: [] });
    expect(await audited(other)).toEqual([]);
  });

  it('lists every agreement by title ignoring case, with its counterparty, for any role with rights:read', async () => {
    const sam = `pty_${ulid()}`;
    const person = { id: sam, partyKind: 'person', displayName: 'Sam Rivera' };
    await (await open(other)).insert(parties).values({ ...person, createdAt: AT, updatedAt: AT });
    const add = async (input: AgreementInput) =>
      accepted(await service.createAgreement(other, input));
    const withSam = await add({ ...DEAL, title: 'B deal', counterpartyPartyId: sam });
    const alone = await add({ agreementType: 'licensing', title: 'a deal' });
    expect([withSam.counterpartyName, alone.counterpartyName]).toEqual(['Sam Rivera', null]);
    const list = async (filter?: AgreementFilter) =>
      accepted(await service.listAgreements(withRole(other, 'viewer'), filter));
    expect(await list()).toEqual([alone, withSam]);
    expect(await list({ agreementType: 'licensing' })).toEqual([alone]);
    expect(await list({ counterpartyPartyId: sam })).toEqual([withSam]);
  });
});
