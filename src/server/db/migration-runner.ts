import { and, eq, or, type SQL } from 'drizzle-orm';
import { ulid } from 'ulid';
import { getServerEnv, type WorkspaceHostSetting } from '../env';
import { errorCode } from '../error-code';
import { controlIntegrityGuard as guard } from '../services/integrity-guard';
import {
  STALE_CLAIM_MS,
  unchanged,
  type WorkspaceRegistryRow,
  writeIf,
} from '../services/workspace-provisioner';
import { controlDb } from './client';
import { controlAuditLog, migrationRuns, workspaceRegistry } from './schema/control';
import { openWorkspaceDatabase, WorkspaceHostConfigError } from './workspace-hosts';
import {
  applyWorkspaceMigrations,
  readSchemaVersion,
  type WorkspaceMigration,
} from './workspace-migrations';
import { EMBEDDED_WORKSPACE_MIGRATIONS } from './workspace-migrations.generated';

type Status = WorkspaceRegistryRow['status'];
type Run = typeof migrationRuns.$inferSelect;
type Batch = {
  batchId: string;
  toVersion: number;
  migrations: readonly WorkspaceMigration[];
  host: WorkspaceHostSetting;
};

/** One workspace of a batch; `unclaimed` when another attempt held or took it, recording no run. */
export type WorkspaceMigrationOutcome = {
  workspaceId: string;
  fromVersion: number;
  toVersion: number;
  status: 'succeeded' | 'failed' | 'skipped' | 'unclaimed';
  /** The error name and code, never a message: a message may hold a token or database URL. */
  error: string | null;
  /** The registry status the runner left or found; `missing` once the row is gone. */
  workspaceStatus: Status | 'missing';
};

export type MigrationBatchResult = {
  batchId: string;
  toVersion: number;
  workspaces: WorkspaceMigrationOutcome[];
};

/** The error of a run whose silent claim a rerun took over (ADR-033). */
const CLAIM_EXPIRED = 'ClaimExpired';
/** The error of a run whose owner write matched nothing: a delete or a rerun took the row. */
const CLAIM_LOST = 'ClaimLost';
/** The waits before each retry of a melos-control write refused by another connection's lock. */
const LOCK_RETRY_MS = [20, 40, 80, 160, 320];

const now = () => new Date().toISOString();
const { id: workspaceKey, status, attemptId } = workspaceRegistry;
const running = (runId: string) =>
  and(eq(migrationRuns.id, runId), eq(migrationRuns.status, 'running')) as SQL;

/** True when a connection refused a write because another connection holds the database lock. */
function isLocked(error: unknown): boolean {
  for (let cause = error; cause instanceof Error; cause = cause.cause) {
    const { code } = cause as { code?: unknown };
    if (typeof code === 'string' && /^SQLITE_(BUSY|LOCKED)/.test(code)) return true;
  }
  return false;
}

/**
 * Runs a melos-control write again, after a jittered wait, while a lock refuses it: libSQL file
 * connections fail at once instead of waiting (ADR-033). A refused transaction has rolled back, so a
 * retry repeats all of it. Throws the lock error once the retries run out.
 */
async function retryLocked<T>(write: () => Promise<T>): Promise<T> {
  for (const wait of LOCK_RETRY_MS) {
    try {
      return await write();
    } catch (error) {
      if (!isLocked(error)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, wait * (1 + Math.random())));
  }
  return write();
}

/** Returns `fallback` for a write a lock still refuses after its retries; rethrows anything else. */
const unlessLocked =
  <T>(fallback: T) =>
  (error: unknown): T => {
    if (isLocked(error)) return fallback;
    throw error;
  };

/** A migration_runs row for `row` in the batch, started now. */
const newRun = (row: WorkspaceRegistryRow, { batchId, toVersion }: Batch, id = `mig_${ulid()}`) => {
  const { id: workspaceId, schemaVersion: fromVersion } = row;
  return { id, batchId, workspaceId, fromVersion, toVersion, startedAt: now() };
};

/**
 * The workspaces a batch takes (§7.2, ADR-033): every `active` one, and each `failed` or `migrating`
 * one whose `attempt_id` still names a `failed` or `running` run of the batch.
 */
function candidates(batchId: string, workspaceId?: string) {
  const held = and(eq(migrationRuns.id, attemptId), eq(migrationRuns.batchId, batchId));
  const taken = or(
    eq(status, 'active'),
    and(eq(status, 'failed'), eq(migrationRuns.status, 'failed')),
    and(eq(status, 'migrating'), eq(migrationRuns.status, 'running')),
  );
  const only = workspaceId === undefined ? undefined : eq(workspaceKey, workspaceId);
  return controlDb
    .select({ row: workspaceRegistry, held: migrationRuns })
    .from(workspaceRegistry)
    .leftJoin(migrationRuns, held)
    .where(and(taken, only))
    .orderBy(workspaceKey);
}

async function statusOf(workspaceId: string): Promise<Status | 'missing'> {
  const byId = eq(workspaceKey, workspaceId);
  const [row] = await controlDb.select({ status }).from(workspaceRegistry).where(byId);
  return row?.status ?? 'missing';
}

/**
 * Claims `row` for the run `runId` and inserts that `running` run in one transaction, only while the
 * row still has the status, `updated_at` and `attempt_id` read. A silent run it takes over fails.
 */
async function claim(row: WorkspaceRegistryRow, held: Run | null, batch: Batch, runId: string) {
  const seen = and(eq(workspaceKey, row.id), unchanged(row));
  const run = newRun(row, batch, runId);
  return controlDb.transaction(async (tx) => {
    const set = { status: 'migrating' as const, attemptId: runId, updatedAt: run.startedAt };
    const [claimed] = await tx.update(workspaceRegistry).set(set).where(seen).returning();
    if (!claimed) return false;
    if (held?.status === 'running') {
      const expired = {
        status: 'failed' as const,
        error: CLAIM_EXPIRED,
        finishedAt: run.startedAt,
      };
      await guard.update(tx, migrationRuns, expired, running(held.id));
    }
    await guard.insert(tx, migrationRuns, [{ ...run, status: 'running' }]);
    return true;
  });
}

/** One workspace: a `skipped` run at the target; otherwise claimed, migrated and finished. */
async function migrateWorkspace(
  listed: WorkspaceRegistryRow,
  batch: Batch,
): Promise<WorkspaceMigrationOutcome> {
  const { batchId, toVersion, migrations, host } = batch;
  // Read again: the row may have changed while earlier workspaces migrated.
  const [current] = await candidates(batchId, listed.id);
  const row = current?.row ?? listed;
  const outcome = { workspaceId: row.id, fromVersion: row.schemaVersion, toVersion, error: null };
  const unclaimed = async (): Promise<WorkspaceMigrationOutcome> => {
    return { ...outcome, status: 'unclaimed', workspaceStatus: await statusOf(row.id) };
  };
  if (current && row.status === 'active' && row.schemaVersion >= toVersion) {
    const run = newRun(row, batch);
    const skipped = [{ ...run, status: 'skipped' as const, finishedAt: run.startedAt }];
    const insert = () => controlDb.transaction((tx) => guard.insert(tx, migrationRuns, skipped));
    if (!(await retryLocked(insert).then(() => true, unlessLocked(false)))) return unclaimed();
    return { ...outcome, status: 'skipped', workspaceStatus: row.status };
  }
  const silent = Date.parse(row.updatedAt) <= Date.now() - STALE_CLAIM_MS;
  if (!current || (row.status === 'migrating' && !silent)) return unclaimed();
  const runId = `mig_${ulid()}`;
  const claiming = () => claim(row, current.held, batch, runId);
  if (!(await retryLocked(claiming).catch(unlessLocked(false)))) return unclaimed();

  const owned = and(eq(attemptId, runId), eq(status, 'migrating'));
  // Each owner write renews the claim; one that matches nothing stops the run.
  const ownerWrite = async (set: Partial<WorkspaceRegistryRow>) => {
    if (!(await retryLocked(() => writeIf(row.id, owned, set)))) throw new Error(CLAIM_LOST);
  };
  // The last version the database committed: a registry write can fail after its version commits.
  let committed = row.schemaVersion;
  let code: string | null = null;
  try {
    const client = openWorkspaceDatabase(host, row);
    try {
      committed = await readSchemaVersion(client);
      if (committed !== row.schemaVersion) await ownerWrite({ schemaVersion: committed });
      const onApplied = async ({ version }: WorkspaceMigration) => {
        committed = version;
        await ownerWrite({ schemaVersion: version });
      };
      await applyWorkspaceMigrations(client, { migrations, onApplied });
    } finally {
      client.close();
    }
  } catch (error) {
    code = errorCode(error).trim();
  }

  const finished =
    code === null
      ? { status: 'active' as const, statusDetail: null }
      : { status: 'failed' as const, statusDetail: `batch ${batchId} failed: ${code}` };
  const ended =
    code === null
      ? { status: 'succeeded' as const, error: null }
      : { status: 'failed' as const, error: code };
  const at = now();
  // The owner's final registry write and its run share a transaction; a lost claim writes only the run.
  const finish = () =>
    controlDb.transaction(async (tx) => {
      const set = { ...finished, schemaVersion: committed, updatedAt: at };
      const mine = and(eq(workspaceKey, row.id), owned);
      const [kept] = await tx.update(workspaceRegistry).set(set).where(mine).returning();
      const recorded = kept ? ended : { status: 'failed' as const, error: CLAIM_LOST };
      await guard.update(tx, migrationRuns, { ...recorded, finishedAt: at }, running(runId));
      return kept;
    });
  try {
    const written = await retryLocked(finish);
    if (written) return { ...outcome, ...ended, workspaceStatus: written.status };
  } catch (error) {
    if (!isLocked(error)) throw error;
    // The row stays migrating with its running run, which a rerun takes over once it is silent.
    const locked = errorCode(error).trim();
    return { ...outcome, status: 'failed', error: locked, workspaceStatus: 'migrating' };
  }
  const workspaceStatus = await statusOf(row.id);
  return { ...outcome, status: 'failed', error: CLAIM_LOST, workspaceStatus };
}

/**
 * docs/CONTRACT.md §7.2 `MigrationRunner` (TEN-005, ADR-033): runs a batch, or reruns the batch
 * `batchId` names, bringing the workspaces it takes to the highest version in `migrations`, one
 * workspace at a time. Throws WorkspaceHostConfigError before writing anything while the workspace
 * host is unconfigured, and otherwise only when melos-control fails, or stays locked before the
 * batch begins; running the batch again resumes it.
 */
export async function runMigrationBatch({
  batchId = ulid(),
  migrations = EMBEDDED_WORKSPACE_MIGRATIONS,
}: {
  batchId?: string;
  migrations?: readonly WorkspaceMigration[];
} = {}): Promise<MigrationBatchResult> {
  const host = getServerEnv().workspaceHost;
  // No database opens without a host, so every claimed workspace would end failed.
  if (host.kind === 'unconfigured') throw new WorkspaceHostConfigError(host.missing);
  const toVersion = migrations.at(-1)?.version ?? 0;
  const started = {
    ...{ id: `cad_${ulid()}`, actorUserId: null, organizationId: null, occurredAt: now() },
    ...{ action: 'migration.batch_started', targetType: 'migration_batch', targetId: batchId },
    afterJson: JSON.stringify({ to_version: toVersion }),
  };
  await retryLocked(() =>
    controlDb.transaction((tx) => guard.insert(tx, controlAuditLog, [started])),
  );
  const batch = { batchId, toVersion, migrations, host };
  const workspaces: WorkspaceMigrationOutcome[] = [];
  for (const { row } of await candidates(batchId)) {
    workspaces.push(await migrateWorkspace(row, batch));
  }
  return { batchId, toVersion, workspaces };
}
