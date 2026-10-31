import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Client, LibsqlBatchError } from '@libsql/client';
import { EMBEDDED_WORKSPACE_MIGRATIONS } from './workspace-migrations.generated.ts';

/** The SQL folder, relative to the repository root. Deployed functions do not include it. */
export const WORKSPACE_MIGRATIONS = './src/server/db/migrations/workspace';
/** The melos-agent-runtime runner tables (§4.1), numbered and applied the same way. */
export const RUNTIME_MIGRATIONS = './src/server/db/migrations/runtime';

/** `NNNN_<name>.sql`: a four-digit version and a lowercase snake_case name. */
const FILE_NAME = /^(\d{4})_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/;

/** The separator drizzle-kit writes in migrations/control, so a trigger body needs no SQL parser. */
const STATEMENT_BREAKPOINT = '--> statement-breakpoint';

/**
 * The §4.2 DDL. Every version's transaction carries it, so version 0 is an empty database and a
 * database already at the latest version is never written. SQLite stores it without IF NOT EXISTS.
 */
const CREATE_SCHEMA_MIGRATIONS = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version     INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  applied_at  TEXT NOT NULL
)`;

/** One numbered file. `name` is the part after the number, recorded in schema_migrations. */
export interface WorkspaceMigration {
  version: number;
  name: string;
  file: string;
  statements: readonly string[];
}

export interface WorkspaceMigrationResult {
  /** The versions this call applied, oldest first. */
  applied: number[];
  /** The database's version afterwards; 0 for an empty database. */
  version: number;
}

/**
 * Reads `folder` into migrations ordered by version, refusing a misnamed file, a duplicate number
 * or a gap, so a bad folder fails before any statement runs. For generators and tests: runtime code
 * applies EMBEDDED_WORKSPACE_MIGRATIONS, which `npm run db:workspace-migrations` renders from it.
 */
export function readWorkspaceMigrations(folder = WORKSPACE_MIGRATIONS): WorkspaceMigration[] {
  const migrations = readdirSync(folder)
    .sort()
    .map((file): WorkspaceMigration => {
      const match = FILE_NAME.exec(file);
      if (!match) throw new Error(`Workspace migration ${file} is not named NNNN_<name>.sql`);
      const statements = readFileSync(join(folder, file), 'utf8')
        .split(STATEMENT_BREAKPOINT)
        .map((statement) => statement.trim())
        .filter((statement) => statement !== '');
      return { version: Number(match[1]), name: match[2], file, statements };
    });
  for (const [index, migration] of migrations.entries()) {
    const previous = migrations[index - 1];
    if (previous?.version === migration.version) {
      throw new Error(
        `Workspace migrations ${previous.file} and ${migration.file} share version ${migration.version}`,
      );
    }
    if (migration.version !== index + 1) {
      throw new Error(
        `Workspace migration ${migration.file} leaves a gap: expected version ${index + 1}`,
      );
    }
  }
  return migrations;
}

/** The highest version in schema_migrations, 0 before the table exists. Reads only. */
export async function readSchemaVersion(client: Client): Promise<number> {
  const table = await client.execute(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
  );
  if (table.rows.length === 0) return 0;
  const { rows } = await client.execute(
    'SELECT coalesce(max(version), 0) AS version FROM schema_migrations',
  );
  return Number(rows[0].version);
}

/**
 * Applies every migration above the database's version, oldest first. Each version runs in one
 * `client.migrate()` call with its schema_migrations row: one transaction per version (§7.2), with
 * foreign keys off for the schema change on file and remote clients alike (§1.4). A failed version
 * leaves nothing of itself and keeps the versions before it. `onApplied` runs after each commit, for
 * callers that record progress in workspace_registry. On a local connection `migrate()` turns
 * foreign keys back on afterwards, so a caller that keeps them off sets the pragma again.
 * `migrations` defaults to the embedded list, so provisioning reads no file.
 */
export async function applyWorkspaceMigrations(
  client: Client,
  {
    migrations = EMBEDDED_WORKSPACE_MIGRATIONS,
    onApplied,
  }: {
    migrations?: readonly WorkspaceMigration[];
    onApplied?: (migration: WorkspaceMigration) => Promise<void> | void;
  } = {},
): Promise<WorkspaceMigrationResult> {
  const current = await readSchemaVersion(client);
  const latest = migrations.at(-1)?.version ?? 0;
  if (current > latest) {
    throw new Error(
      `Workspace database is at version ${current}, newer than the latest migration ${latest}`,
    );
  }
  const applied: number[] = [];
  for (const migration of migrations.filter(({ version }) => version > current)) {
    try {
      await client.migrate([
        CREATE_SCHEMA_MIGRATIONS,
        ...migration.statements,
        {
          sql: 'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
          args: [migration.version, migration.name, new Date().toISOString()],
        },
      ]);
    } catch (error) {
      throw migrationError(migration, error);
    }
    applied.push(migration.version);
    await onApplied?.(migration);
  }
  return { applied, version: applied.at(-1) ?? current };
}

/** Names the version, the file and, when one of the file's statements failed, its position. */
function migrationError(migration: WorkspaceMigration, error: unknown): Error {
  // Batch statement 0 is CREATE_SCHEMA_MIGRATIONS, so batch index i is the file's statement i.
  const index = error instanceof LibsqlBatchError ? error.statementIndex : 0;
  const position =
    index >= 1 && index <= migration.statements.length ? ` at statement ${index}` : '';
  const reason = error instanceof Error ? error.message : String(error);
  return new Error(
    `Workspace migration ${migration.version} (${migration.file}) failed${position}: ${reason}`,
    { cause: error },
  );
}
