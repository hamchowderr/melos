import { type Client, createClient } from '@libsql/client';
import { eq, getTableColumns } from 'drizzle-orm';
import { ulid } from 'ulid';
import { controlDb } from '../db/client';
import { controlAuditLog, workspaceRegistry } from '../db/schema/control';
import { createTokenCipher } from '../db/token-cipher';
import { createWorkspaceHost } from '../db/workspace-hosts';
import { applyWorkspaceMigrations } from '../db/workspace-migrations';
import { getServerEnv } from '../env';
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

/** The first name and code in the cause chain. Messages are never kept: they may hold a token. */
function errorCode(error: unknown): string {
  for (let cause = error; cause instanceof Error; cause = cause.cause) {
    const { code } = cause as { code?: unknown };
    if (typeof code === 'string') return `${cause.name} ${code}`;
  }
  return error instanceof Error ? error.name : 'unknown error';
}

/** The registry row as `after_json`: every column by SQL name except db_token_ciphertext. */
function auditJson(row: WorkspaceRegistryRow): string {
  const columns = Object.entries(getTableColumns(workspaceRegistry));
  const pairs = columns.map(([key, { name }]) => [name, row[key as 'id']]);
  return JSON.stringify(
    Object.fromEntries(pairs.filter(([name]) => name !== 'db_token_ciphertext')),
  );
}

/** Step 1: the registry row and `workspace.provisioned`, in one melos-control transaction. */
async function register(organizationId: string, actorUserId: string | null) {
  const key = ulid();
  const at = now();
  // database_url is known once the host has created the database (step 2).
  const database = { databaseName: `melos-ws-${key}`, databaseUrl: '', dbTokenCiphertext: null };
  const row: WorkspaceRegistryRow = {
    ...{ id: `ws_${key}`, organizationId, ...database, schemaVersion: 0 },
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

async function updateRow(id: string, set: Partial<WorkspaceRegistryRow>) {
  const where = eq(workspaceRegistry.id, id);
  return controlDb.transaction(async (tx) => {
    await guard.update(tx, workspaceRegistry, { ...set, updatedAt: now() }, where);
    const [row] = await tx.select().from(workspaceRegistry).where(where);
    return row;
  });
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

/**
 * docs/CONTRACT.md §7.2 for one organization; returns its `active` registry row as it is or once
 * provisioned. A `failed` row, or one a crash left `provisioning`, resumes on the database it names.
 * A failed step sets `failed` with the step and error code, then throws (P-23).
 */
export async function provisionWorkspace(
  organizationId: string,
  actorUserId: string | null = null,
): Promise<WorkspaceRegistryRow> {
  const byOrganization = eq(workspaceRegistry.organizationId, organizationId);
  const [existing] = await controlDb.select().from(workspaceRegistry).where(byOrganization);
  if (existing?.status === 'active') return existing;
  if (existing && existing.status !== 'failed' && existing.status !== 'provisioning') {
    throw new Error(`Workspace ${existing.id} is ${existing.status} and cannot be provisioned`);
  }
  const row = existing ?? (await register(organizationId, actorUserId));

  const setting = getServerEnv().workspaceHost;
  let step = 'create_database';
  try {
    // Both hosts return the database an earlier attempt created (ADR-031).
    const { url, tokenCiphertext } = await createWorkspaceHost(setting).create(row.databaseName);
    const created = { databaseUrl: url, dbTokenCiphertext: tokenCiphertext };
    await updateRow(row.id, { ...created, status: 'provisioning', statusDetail: null });
    const authToken =
      setting.kind === 'turso' && tokenCiphertext
        ? createTokenCipher(setting.tokenKey).decrypt(tokenCiphertext, row.databaseName)
        : undefined;
    const client = createClient({ url, authToken });
    try {
      step = 'migrate';
      const { version } = await applyWorkspaceMigrations(client);
      step = 'seed';
      await seed(client);
      step = 'activate';
      const active = { schemaVersion: version, status: 'active', statusDetail: null } as const;
      return await updateRow(row.id, active);
    } finally {
      client.close();
    }
  } catch (error) {
    const statusDetail = `${step} failed: ${errorCode(error)}`;
    await updateRow(row.id, { status: 'failed', statusDetail });
    throw new Error(`Workspace ${row.id} ${statusDetail}`);
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

/** Recorded when an unconfigured host refused the create, which therefore never reached a host. */
const CREATE_NEVER_REACHED_HOST = 'create_database failed: WorkspaceHostConfigError';

/**
 * §7.2 organization delete, steps 1 and 2: commits `deleting`, then deletes the database. Returns
 * the row for `removeWorkspace`, or undefined when there is none. A failed host delete keeps the
 * row `deleting` with the step and error code; deleting again resumes. Throws WorkspaceDeleteError.
 */
export async function deleteWorkspaceDatabase(
  organizationId: string,
): Promise<WorkspaceRegistryRow | undefined> {
  let step = 'read_registry';
  try {
    const byOrganization = eq(workspaceRegistry.organizationId, organizationId);
    const [existing] = await controlDb.select().from(workspaceRegistry).where(byOrganization);
    if (!existing) return undefined;
    const host = createWorkspaceHost(getServerEnv().workspaceHost);
    const { databaseName, databaseUrl, statusDetail } = existing;
    // Without a host, only a create that never reached one proves no database exists. Any other row
    // is refused before it is marked (an unconfigured delete throws), so it keeps its status.
    step = 'delete_database';
    const neverCreated = databaseUrl === '' && statusDetail === CREATE_NEVER_REACHED_HOST;
    if (host.kind === 'unconfigured' && !neverCreated) await host.delete(databaseName);
    step = 'mark_deleting';
    const row = await updateRow(existing.id, { status: 'deleting' });
    if (host.kind === 'unconfigured') return row;
    step = 'delete_database';
    try {
      await host.delete(databaseName);
    } catch (error) {
      await updateRow(row.id, { statusDetail: `delete_database failed: ${errorCode(error)}` });
      throw error;
    }
    return row;
  } catch (error) {
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
