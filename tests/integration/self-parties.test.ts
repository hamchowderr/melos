import { sql } from 'drizzle-orm';
import { ulid } from 'ulid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as tables from '../../src/server/db/schema/workspace.generated';
import { canonicalJson } from '../../src/server/services/audit-writer';
import { failure, success } from '../../src/server/services/service-result';
import type { TenantContext } from '../../src/server/services/tenant-context';
import { prepareWorkspaceServices, withRole } from './workspace-service';

const AT = '2026-09-15T12:00:00.000Z';
/** A person and two organizations in the owner's workspace, and a person in another workspace. */
const [RILEY, HARBOR, TIDE, ELSEWHERE] = [1, 2, 3, 4].map(() => `pty_${ulid()}`);
const NONE = { writer: null, publishing: null, master: null };
let services: Awaited<ReturnType<typeof prepareWorkspaceServices>>;
let service: typeof import('../../src/server/services/rights/self-parties');
let owner: TenantContext;
let other: TenantContext;

const open = (tenant: TenantContext) =>
  services.connections.getWorkspaceDatabase(tenant.workspaceId);
const party = (id: string, partyKind: string, displayName: string) =>
  open(id === ELSEWHERE ? other : owner).then((db) =>
    db.insert(tables.parties).values({ id, partyKind, displayName, createdAt: AT, updatedAt: AT }),
  );
const dto = { partyKind: 'organization' };
const [riley, harbor, tide] = [
  { partyId: RILEY, partyKind: 'person', displayName: 'Riley Stone' },
  { ...dto, partyId: HARBOR, displayName: 'Harbor Lane Music' },
  { ...dto, partyId: TIDE, displayName: 'Tidewater Records' },
];

/** Stored rows and audit rows, once PRAGMA foreign_key_check is empty (DAT-INT-001). */
async function stored(tenant = owner) {
  const db = await open(tenant);
  expect(await db.all(sql`PRAGMA foreign_key_check`)).toEqual([]);
  const rows = await db.select().from(tables.workspaceSelfParties);
  return { rows, audit: await db.select().from(tables.auditLog) };
}
/** Each side's stored row as the audit records it, or null. */
const sides = (rows: Awaited<ReturnType<typeof stored>>['rows']) =>
  Object.fromEntries(
    ['writer', 'publishing', 'master'].map((side) => [
      side,
      rows.find((r) => r.side === side) ?? null,
    ]),
  );

beforeAll(async () => {
  services = await prepareWorkspaceServices('self-parties');
  service = await import('../../src/server/services/rights/self-parties');
  [owner, other] = [await services.provision('owner'), await services.provision('owner')];
  await party(RILEY, 'person', 'Riley Stone');
  await party(HARBOR, 'organization', 'Harbor Lane Music');
  await party(TIDE, 'organization', 'Tidewater Records');
  await party(ELSEWHERE, 'person', 'Sam Rivera');
});

afterAll(() => services?.close());

describe('melos-rpr.11: updateSelfParties stores the workspace self parties (RGT-008, D-5)', () => {
  it('sets, changes and clears sides with one self_parties.update audit row per change (AUD-INT-001)', async () => {
    const first = { writer: RILEY, publishing: HARBOR, master: TIDE };
    expect(await service.updateSelfParties(owner, first)).toEqual(
      success({ writer: riley, publishing: harbor, master: tide }),
    );
    const set = await stored();
    const row = { updatedAt: expect.any(String), updatedBy: owner.userId };
    expect(sides(set.rows)).toEqual({
      writer: { ...row, side: 'writer', partyId: RILEY, partyKind: 'person' },
      publishing: { ...row, side: 'publishing', partyId: HARBOR, partyKind: 'organization' },
      master: { ...row, side: 'master', partyId: TIDE, partyKind: 'organization' },
    });

    const second = { writer: RILEY, publishing: TIDE, master: null };
    const expected = { writer: riley, publishing: tide, master: null };
    expect(await service.updateSelfParties(owner, second)).toEqual(success(expected));
    expect(await service.getSelfParties(withRole(owner, 'viewer'))).toEqual(success(expected));
    // A save that changes nothing writes nothing.
    expect(await service.updateSelfParties(owner, second)).toEqual(success(expected));
    const changed = await stored();
    expect(sides(changed.rows)).toMatchObject({ publishing: { partyId: TIDE }, master: null });
    const audit = {
      ...{
        actorType: 'user',
        actorUserId: owner.userId,
        agentRunId: null,
        approvalToolCallId: null,
      },
      ...{ action: 'self_parties.update', entityType: 'self_parties', entityId: owner.workspaceId },
      ...{ requestId: owner.requestId, id: expect.stringMatching(/^aud_/), occurredAt: AT },
    };
    const json = (rows: typeof set.rows) => canonicalJson(sides(rows));
    expect(changed.audit.map((entry) => ({ ...entry, occurredAt: AT }))).toEqual([
      { ...audit, beforeJson: json([]), afterJson: json(set.rows) },
      { ...audit, beforeJson: json(set.rows), afterJson: json(changed.rows) },
    ]);
  });

  it('lets owner, admin and member save and refuses viewer and owner,viewer with FORBIDDEN before opening the database (§6.2, P-30)', async () => {
    const earlier = await stored();
    services.getWorkspaceDatabase.mockClear();
    for (const [role, master] of [
      ['owner', HARBOR],
      ['admin', TIDE],
      ['member', HARBOR],
    ]) {
      const saved = await service.updateSelfParties(withRole(owner, role), { ...NONE, master });
      expect(saved, role).toMatchObject({ ok: true, value: { master: { partyId: master } } });
    }
    // Probe: each allowed save asks for the database through the recorded function.
    expect(services.getWorkspaceDatabase).toHaveBeenCalledTimes(3);
    expect((await stored()).audit).toHaveLength(earlier.audit.length + 3);
    const before = await stored();
    services.getWorkspaceDatabase.mockClear();
    for (const role of ['viewer', 'owner,viewer']) {
      const refused = await service.updateSelfParties(withRole(owner, role), NONE);
      expect(refused, role).toEqual(failure('FORBIDDEN'));
    }
    const read = await service.getSelfParties(withRole(owner, 'owner,viewer'));
    expect([read, services.getWorkspaceDatabase.mock.calls]).toEqual([failure('FORBIDDEN'), []]);
    expect(await stored()).toEqual(before);
  });

  it('answers VALIDATION for an organization on the writer side before the §4.2 CHECK, writing nothing', async () => {
    const before = await stored();
    const input = { writer: HARBOR, publishing: RILEY, master: TIDE };
    const refused = await service.updateSelfParties(owner, input);
    expect(refused).toEqual(
      failure({ code: 'VALIDATION', field: 'writer', reason: 'person_required' }),
    );
    expect(await stored()).toEqual(before);
    // Probe: the DDL CHECK refuses the same row written directly.
    const db = await open(owner);
    const row = { side: 'writer', partyId: HARBOR, partyKind: 'organization', updatedAt: AT };
    const direct = db.insert(tables.workspaceSelfParties).values(row);
    expect(await direct.catch((error: Error) => `${error.cause}`)).toMatch(
      /CHECK constraint failed/,
    );
  });

  it('answers NOT_FOUND for a party id from another workspace, writing nothing in either (TEN-001)', async () => {
    const before = [await stored(), await stored(other)];
    const refused = await service.updateSelfParties(owner, { ...NONE, writer: ELSEWHERE });
    expect(refused).toEqual(failure({ code: 'NOT_FOUND', counts: { parties: 1 } }));
    expect([await stored(), await stored(other)]).toEqual(before);
    expect(before[1]).toEqual({ rows: [], audit: [] });
  });
});
