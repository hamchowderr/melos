import { eq, sql } from 'drizzle-orm';
import { ulid } from 'ulid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { WorkspacePermissions } from '../../src/lib/auth/permissions';
import { auditLog, compositions, recordings } from '../../src/server/db/schema/workspace.generated';
import { type AuditAction, canonicalJson } from '../../src/server/services/audit-writer';
import { workspaceIntegrityGuard as guard } from '../../src/server/services/integrity-guard';
import { failure, type ServiceResult, success } from '../../src/server/services/service-result';
import type { TenantContext } from '../../src/server/services/tenant-context';
import type { WorkspaceConnectionError } from '../../src/server/services/workspace-connections';
import type { WorkspaceWrite } from '../../src/server/services/workspace-write';
import { prepareWorkspaceServices, withRole } from './workspace-service';

const AT = '2026-09-14T18:00:00.000Z';
const CREATE: WorkspacePermissions = { catalog: ['create'] };
let services: Awaited<ReturnType<typeof prepareWorkspaceServices>>;
let write: typeof import('../../src/server/services/workspace-write');
let member: TenantContext;
let other: TenantContext;

const song = (title: string) => ({ id: `cmp_${ulid()}`, title, createdAt: AT, updatedAt: AT });
const take = (of: Song) => ({ ...of, id: `rec_${ulid()}`, compositionId: of.id });
type Song = ReturnType<typeof song>;
type State = object | null;
const open = (tenant: TenantContext) =>
  services.connections.getWorkspaceDatabase(tenant.workspaceId);
/** An audit entry whose entity type is the one its action names. */
const entry = (action: AuditAction, entityId: string, before: State, after: State) => ({
  ...{ action, entityType: action.split('.')[0], entityId, before, after },
});
/** Inserts `created` through the guard and audits it, then ends with `end`. */
const create =
  (created: Song, end = (): ServiceResult<string> => success(created.id)): WorkspaceWrite<string> =>
  async (tx, audit) => {
    await guard.insert(tx, compositions, [created]);
    await audit.write(entry('composition.create', created.id, null, created));
    return end();
  };

beforeAll(async () => {
  services = await prepareWorkspaceServices('workspace-write');
  write = await import('../../src/server/services/workspace-write');
  [member, other] = [await services.provision('member'), await services.provision('member')];
});

afterAll(() => services?.close());

describe('melos-rpr.3: runWorkspaceWrite authorizes, guards and audits one transaction (AUTH-004, AUD-001, DAT-001)', () => {
  it('refuses viewer and owner,viewer with FORBIDDEN before opening the database (§6.2, P-30)', async () => {
    const core = vi.fn();
    services.getWorkspaceDatabase.mockClear();
    for (const role of ['viewer', 'owner,viewer']) {
      const refused = await write.runWorkspaceWrite(withRole(member, role), CREATE, core);
      expect(refused, role).toEqual({ ok: false, error: { code: 'FORBIDDEN' } });
    }
    expect([core.mock.calls, services.getWorkspaceDatabase.mock.calls]).toEqual([[], []]);
    // Probe: an allowed call asks for the database through the recorded function.
    const allowed = await write.runWorkspaceWrite(member, CREATE, async () => success(null));
    expect(allowed).toEqual(success(null));
    expect(services.getWorkspaceDatabase.mock.calls).toEqual([[member.workspaceId]]);
  });

  it('commits each write with one audit_log row: actor, request id, action, entity, canonical before and after', async () => {
    const db = await open(member);
    const earlier = await db.select().from(auditLog);
    const midnight = song('Midnight Drive');
    const byId = eq(compositions.id, midnight.id);
    const created = await write.runWorkspaceWrite(member, CREATE, create(midnight));
    const [stored] = await db.select().from(compositions).where(byId);
    const renamed = { ...stored, title: 'Midnight Drive (Remix)' };
    const rename: WorkspaceWrite<null> = async (tx, audit) => {
      await guard.update(tx, compositions, { title: renamed.title }, byId);
      await audit.write(entry('composition.update', midnight.id, stored, renamed));
      return success(null);
    };
    // An agent run acting on an approval; the actor's user is still the tenant's (AUD-002).
    const agent = { agentRunId: `run_${ulid()}`, approvalToolCallId: `call_${ulid()}` };
    const via = { type: 'agent', ...agent } as const;
    const updated = await write.runWorkspaceWrite(member, { catalog: ['update'] }, rename, via);
    expect([created, updated]).toEqual([success(midnight.id), success(null)]);

    const row = {
      ...{ id: expect.stringMatching(/^aud_[0-9A-HJKMNP-TV-Z]{26}$/), actorUserId: member.userId },
      ...{ entityType: 'composition', entityId: midnight.id, requestId: member.requestId },
      occurredAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
    };
    const user = { actorType: 'user', agentRunId: null, approvalToolCallId: null };
    const inserted = { action: 'composition.create', beforeJson: null };
    const changed = { beforeJson: canonicalJson(stored), afterJson: canonicalJson(renamed) };
    expect(await db.select().from(auditLog)).toEqual([
      ...earlier,
      { ...row, ...user, ...inserted, afterJson: canonicalJson(midnight) },
      { ...row, actorType: 'agent', ...agent, action: 'composition.update', ...changed },
    ]);
    const sorted = `{"createdAt":"${AT}","id":"${midnight.id}","title":"Midnight Drive","updatedAt":"${AT}"}`;
    expect(canonicalJson(midnight)).toBe(sorted);
    expect(await db.all(sql`PRAGMA foreign_key_check`)).toEqual([]);
  });

  it('leaves neither the row nor its audit row when the write throws or refuses after inserting', async () => {
    const db = await open(member);
    const earlier = await db.select().from(auditLog);
    const neon = song('Neon Static');
    const boom = () => {
      throw new Error('boom: file:./data/secret.db');
    };
    const hidden = { name: 'WorkspaceConnectionError', message: expect.not.stringMatching(/boom/) };
    const thrown = write.runWorkspaceWrite(member, CREATE, create(neon, boom));
    await expect(thrown).rejects.toMatchObject({ ...hidden, code: 'Error' });
    const notFound = () => failure('NOT_FOUND');
    const refused = await write.runWorkspaceWrite(member, CREATE, create(neon, notFound));
    expect(refused).toEqual(failure('NOT_FOUND'));
    expect(await db.select().from(compositions).where(eq(compositions.id, neon.id))).toEqual([]);
    expect(await db.select().from(auditLog)).toEqual(earlier);
  });

  it('answers a real IntegrityGuard refusal with REFERENCED and its counts, keeping nothing (§4.4, D-11)', async () => {
    const db = await open(member);
    const ocean = song('Ocean Blue');
    await db.batch([
      db.insert(compositions).values(ocean),
      db.insert(recordings).values(take(ocean)),
    ]);
    const earlier = await db.select().from(auditLog);
    const owner = withRole(member, 'owner');
    const byId = eq(compositions.id, ocean.id);
    const remove: WorkspaceWrite<null> = async (tx, audit) => {
      // Audited first, so only the rollback removes the audit row.
      await audit.write(entry('composition.delete', ocean.id, ocean, null));
      await guard.softDelete(tx, compositions, byId, owner.userId);
      return success(null);
    };
    const refused = await write.runWorkspaceWrite(owner, { catalog: ['delete'] }, remove);
    expect(refused).toEqual({
      ok: false,
      error: { code: 'REFERENCED', counts: { recordings: 1 } },
    });
    const kept = await db
      .select({ deletedAt: compositions.deletedAt })
      .from(compositions)
      .where(byId);
    expect([kept, await db.select().from(auditLog)]).toEqual([[{ deletedAt: null }], earlier]);
    expect(await db.all(sql`PRAGMA foreign_key_check`)).toEqual([]);
  });

  it('throws a libSQL error as WorkspaceConnectionError with its name and code, never its SQL or message (§7.2)', async () => {
    const db = await open(member);
    const paper = song('Paper Planes');
    await db.insert(compositions).values(paper);
    // Probe: the raw error names the constraint the duplicate id breaks.
    const raw = await db
      .insert(compositions)
      .values(paper)
      .then(
        () => null,
        (error: Error) => error,
      );
    expect(`${raw} ${raw?.cause}`).toMatch(/UNIQUE constraint failed: compositions\.id/);
    const duplicate = write.runWorkspaceWrite(member, CREATE, create(paper));
    const error = (await duplicate.catch((thrown) => thrown)) as WorkspaceConnectionError;
    expect(error).toBeInstanceOf(services.connections.WorkspaceConnectionError);
    expect(error.code).toMatch(/^\w+ SQLITE_CONSTRAINT\w*$/);
    const text = `Workspace ${member.workspaceId} database is unavailable: ${error.code}`;
    expect([error.message, error.cause]).toEqual([text, undefined]);
  });

  it('writes only the tenant database: a composition id from another workspace is NOT_FOUND (TEN-001)', async () => {
    const home = song('Home Again');
    await (await open(member)).insert(compositions).values(home);
    const recording = take(home);
    const record: WorkspaceWrite<string> = async (tx, audit) => {
      await audit.write(entry('recording.create', recording.id, null, recording));
      await guard.insert(tx, recordings, [recording]);
      return success(recording.id);
    };
    services.getWorkspaceDatabase.mockClear();
    const refused = await write.runWorkspaceWrite(other, CREATE, record);
    expect(refused).toEqual({
      ok: false,
      error: { code: 'NOT_FOUND', counts: { compositions: 1 } },
    });
    expect(services.getWorkspaceDatabase.mock.calls).toEqual([[other.workspaceId]]);
    for (const tenant of [member, other]) {
      const rows = (await open(tenant)).select().from(recordings);
      expect(await rows.where(eq(recordings.id, recording.id))).toEqual([]);
    }
    expect(await (await open(other)).select().from(auditLog)).toEqual([]);
  });
});
