import type { Client } from '@libsql/client';
import { and, eq, getTableColumns, isNull, type SQL } from 'drizzle-orm';
import { ulid } from 'ulid';
import { controlDb } from '../db/client';
import { controlAuditLog, workspaceRegistry } from '../db/schema/control';
import { createWorkspaceHost, openWorkspaceDatabase } from '../db/workspace-hosts';
import { applyWorkspaceMigrations } from '../db/workspace-migrations';
import { getServerEnv } from '../env';
import { errorCode } from '../error-code';
import { type GuardTransaction, controlIntegrityGuard as guard } from './integrity-guard';

export type WorkspaceRegistryRow = typeof workspaceRegistry.$inferSelect;

/** Report sections in their fixed order (§6.12, §7.7). */
const SECTIONS = 'core rights creators composition recording metadata listen licensing lyrics';

const preset = (presetKey: string, name: string, enabled: (section: string) => boolean) => {
  const sections = SECTIONS.split(' ').map((id) => ({ id, enabled: enabled(id) }));
  return { presetKey, name, configJson: JSON.stringify({ sections, format: 'text' }) };
};

/** The system presets of every workspace; disco_track_info waits for RPT-004 (§7.7). */
const SYSTEM_TEMPLATES = [
  preset('full', 'Full report', () => true),
  preset('sans_lyrics', 'Report without lyrics', (id) => id !== 'lyrics'),
  preset('just_lyrics', 'Lyrics only', (id) => id === 'lyrics'),
];

const now = () => new Date().toISOString();

/** The registry row as `after_json`: every column by SQL name except db_token_ciphertext. */
function auditJson(row: WorkspaceRegistryRow): string {
  const columns = Object.entries(getTableColumns(workspaceRegistry));
  const pairs = columns.map(([key, { name }]) => [name, row[key as 'id']]);
  return JSON.stringify(
    Object.fromEntries(pairs.filter(([name]) => name !== 'db_token_ciphertext')),
  );
}

/** Step 1: the row, claimed by `attemptId`, and `workspace.provisioned`, in one transaction. */
async function register(organizationId: string, attemptId: string, actorUserId: string | null) {
  const key = ulid();
  const at = now();
  // database_url is known once the host has created the database (step 2).
  const database = { databaseName: `melos-ws-${key}`, databaseUrl: '', dbTokenCiphertext: null };
  const row: WorkspaceRegistryRow = {
    ...{ id: `ws_${key}`, organizationId, ...database, schemaVersion: 0, attemptId },
    ...{ status: 'provisioning', statusDetail: null, createdAt: at, updatedAt: at },
  };
  const audit = { id: `cad_${ulid()}`, actorUserId, organizationId, occurredAt: at };
  const target = { action: 'workspace.provisioned', targetType: 'workspace', targetId: row.id };
  await controlDb.transaction(async (tx) => {
    await guard.insert(tx, workspaceRegistry, [row]);
    await guard.insert(tx, controlAuditLog, [{ ...audit, ...target, afterJson: auditJson(row) }]);
  });
  return row;
}

/** Step 3's rows in one write batch; a rerun after a crash before `activate` inserts nothing. */
async function seed(client: Client) {
  const at = now();
  const settings = {
    sql: 'INSERT INTO workspace_settings (id, follow_up_interval_days, updated_at) VALUES (1, 7, ?) ON CONFLICT DO NOTHING',
    args: [at],
  };
  const templates = SYSTEM_TEMPLATES.map(({ presetKey, name, configJson }) => ({
    sql: `INSERT INTO report_templates (id, name, report_type, preset_key, config_json, is_system, created_at, updated_at)
          VALUES (?, ?, 'metadata_package', ?, ?, 1, ?, ?) ON CONFLICT (preset_key) DO NOTHING`,
    args: [`tpl_${ulid()}`, name, presetKey, configJson, at, at],
  }));
  await client.batch([settings, ...templates], 'write');
}

/** A `provisioning` row whose attempt has written nothing for this long may be claimed (ADR-032). */
export const STALE_CLAIM_MS = 15 * 60_000;

const readRow = async (organizationId: string): Promise<WorkspaceRegistryRow | undefined> =>
  (
    await controlDb
      .select()
      .from(workspaceRegistry)
      .where(eq(workspaceRegistry.organizationId, organizationId))
  )[0];

/**
 * One conditional UPDATE: writes `set` and returns the row only while `where` still matches, so it
 * is atomic without holding a transaction. It sets no key column, so IntegrityGuard has no §4.4
 * check to apply.
 */
export async function writeIf(
  id: string,
  where: SQL | undefined,
  set: Partial<WorkspaceRegistryRow>,
) {
  const matches = and(eq(workspaceRegistry.id, id), where);
  const update = controlDb.update(workspaceRegistry).set({ ...set, updatedAt: now() });
  const [row] = await update.where(matches).returning();
  return row as WorkspaceRegistryRow | undefined;
}

/** Matches the row only while it keeps the `status`, `updated_at` and `attempt_id` read. */
export function unchanged(row: WorkspaceRegistryRow): SQL | undefined {
  const { status, updatedAt, attemptId } = workspaceRegistry;
  const held = row.attemptId === null ? isNull(attemptId) : eq(attemptId, row.attemptId);
  return and(eq(status, row.status), eq(updatedAt, row.updatedAt), held);
}

/** A `provisioning` row written within STALE_CLAIM_MS: its attempt may still be running. */
const liveClaim = (row: WorkspaceRegistryRow) =>
  row.status === 'provisioning' && Date.parse(row.updatedAt) > Date.now() - STALE_CLAIM_MS;

/**
 * Claims the organization's row for `attemptId` (ADR-032): registers a missing row, or moves a
 * `failed` or stale `provisioning` row to `provisioning` under the attempt, only while the row is
 * still the version read. Any other row comes back unclaimed.
 */
async function claim(organizationId: string, attemptId: string, actorUserId: string | null) {
  const row = await readRow(organizationId);
  if (!row) {
    // The unique organization_id lets one of two overlapping registrations insert.
    return register(organizationId, attemptId, actorUserId).catch(async (error: unknown) => {
      const raced = await readRow(organizationId);
      if (!raced) throw error;
      return raced;
    });
  }
  if (row.status !== 'failed' && (row.status !== 'provisioning' || liveClaim(row))) return row;
  const claimed = await writeIf(row.id, unchanged(row), { status: 'provisioning', attemptId });
  return claimed ?? (await readRow(organizationId)) ?? row;
}

/**
 * docs/CONTRACT.md §7.2 for one organization. Returns its registry row: `active` as it is or once
 * provisioned, or unchanged while another live attempt holds its claim (ADR-032). A `failed` row, or
 * one whose attempt went silent, resumes on the database it names. A failed step sets `failed` with
 * the step and error code, then throws (P-23). An attempt that lost its claim writes nothing more;
 * when a delete went past it, it deletes the database it may have created.
 */
export async function provisionWorkspace(
  organizationId: string,
  actorUserId: string | null = null,
): Promise<WorkspaceRegistryRow> {
  const attemptId = ulid();
  const row = await claim(organizationId, attemptId, actorUserId);
  if (row.attemptId !== attemptId) {
    if (['active', 'provisioning', 'failed'].includes(row.status)) return row;
    throw new Error(`Workspace ${row.id} is ${row.status} and cannot be provisioned`);
  }
  const owned = and(
    eq(workspaceRegistry.attemptId, attemptId),
    eq(workspaceRegistry.status, 'provisioning'),
  );
  /** Writes as the claim's owner, renewing the claim; throws once the attempt no longer holds it. */
  const ownerWrite = async (set: Partial<WorkspaceRegistryRow>) => {
    const written = await writeIf(row.id, owned, set);
    if (!written) throw new Error('Workspace claim lost');
    return written;
  };

  const setting = getServerEnv().workspaceHost;
  const host = createWorkspaceHost(setting);
  let step = 'create_database';
  try {
    // Both hosts return the database an earlier attempt created (ADR-031).
    const { url, tokenCiphertext } = await host.create(row.databaseName);
    await ownerWrite({ databaseUrl: url, dbTokenCiphertext: tokenCiphertext, statusDetail: null });
    const database = { databaseUrl: url, dbTokenCiphertext: tokenCiphertext };
    const client = openWorkspaceDatabase(setting, { ...row, ...database });
    try {
      step = 'migrate';
      const onApplied = async () => void (await ownerWrite({}));
      const { version } = await applyWorkspaceMigrations(client, { onApplied });
      step = 'seed';
      await seed(client);
      step = 'activate';
      return await ownerWrite({ schemaVersion: version, status: 'active', statusDetail: null });
    } finally {
      client.close();
    }
  } catch (error) {
    const statusDetail = `${step} failed: ${errorCode(error)}`;
    // Only the owner writes `failed`, so a superseded attempt never overwrites the new owner's row.
    if (await writeIf(row.id, owned, { status: 'failed', statusDetail })) {
      throw new Error(`Workspace ${row.id} ${statusDetail}`);
    }
    // The claim is lost. Another attempt's row keeps the database, which that attempt uses; a gone
    // or deleting row means a delete went past a stale claim, maybe before the create finished.
    const current = await readRow(organizationId);
    if (current && current.status !== 'deleting') return current;
    await host.delete(row.databaseName).catch((cleanup: unknown) => {
      const at = `delete_database: ${errorCode(cleanup)}`;
      console.error(`Workspace cleanup failed for organization ${organizationId} at ${at}`);
    });
    if (current) return current;
    throw new Error(`Workspace ${row.id} was deleted while it was provisioning`);
  }
}

/** A workspace delete stopped at `step`; `code` holds the error name and code, never a message. */
export class WorkspaceDeleteError extends Error {
  constructor(
    readonly step: string,
    readonly code: string,
  ) {
    super(`Workspace delete failed at ${step}: ${code}`);
    this.name = 'WorkspaceDeleteError';
  }
}

/** Refuses a delete that a provisioning attempt could outrun by creating the database (ADR-032). */
const claimHeld = () => new WorkspaceDeleteError('provisioning_in_progress', 'WorkspaceClaimHeld');

/** Recorded when an unconfigured host refused the create, which therefore never reached a host. */
const CREATE_NEVER_REACHED_HOST = 'create_database failed: WorkspaceHostConfigError';

/**
 * §7.2 organization delete, steps 1 and 2: commits `deleting`, then deletes the database. Returns
 * the row for `removeWorkspace`, or undefined when there is none. A failed host delete keeps the
 * row `deleting` with the step and error code; deleting again resumes. A row under a live claim, or
 * claimed after it was read, is refused and keeps its status. Throws WorkspaceDeleteError.
 */
export async function deleteWorkspaceDatabase(
  organizationId: string,
): Promise<WorkspaceRegistryRow | undefined> {
  let step = 'read_registry';
  try {
    const existing = await readRow(organizationId);
    if (!existing) return undefined;
    if (liveClaim(existing)) throw claimHeld();
    const host = createWorkspaceHost(getServerEnv().workspaceHost);
    const { databaseName, databaseUrl, statusDetail } = existing;
    // Without a host, only a create that never reached one proves no database exists. Any other row
    // is refused before it is marked (an unconfigured delete throws), so it keeps its status.
    step = 'delete_database';
    const neverCreated = databaseUrl === '' && statusDetail === CREATE_NEVER_REACHED_HOST;
    if (host.kind === 'unconfigured' && !neverCreated) await host.delete(databaseName);
    step = 'mark_deleting';
    const row = await writeIf(existing.id, unchanged(existing), { status: 'deleting' });
    if (!row) throw claimHeld();
    if (host.kind === 'unconfigured') return row;
    step = 'delete_database';
    try {
      await host.delete(databaseName);
    } catch (error) {
      const failed = `delete_database failed: ${errorCode(error)}`;
      await writeIf(row.id, undefined, { statusDetail: failed });
      throw error;
    }
    return row;
  } catch (error) {
    if (error instanceof WorkspaceDeleteError) throw error;
    throw new WorkspaceDeleteError(step, errorCode(error));
  }
}

/** §7.2 organization delete, step 3, in the transaction that deletes the organization (ADR-030). */
export async function removeWorkspace(
  tx: GuardTransaction,
  row: WorkspaceRegistryRow,
  actorUserId: string | null,
): Promise<void> {
  const { id, organizationId } = row;
  const audit = { id: `cad_${ulid()}`, actorUserId, organizationId, occurredAt: now() };
  const target = { action: 'workspace.deleted', targetType: 'workspace', targetId: id };
  await guard.insert(tx, controlAuditLog, [{ ...audit, ...target, beforeJson: auditJson(row) }]);
  // Its migration_runs rows cascade.
  await guard.delete(tx, workspaceRegistry, eq(workspaceRegistry.id, id));
}
