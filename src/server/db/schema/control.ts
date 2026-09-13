import { sql } from 'drizzle-orm';
import { check, index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { organization, user } from './auth';

// Control-plane tables from docs/CONTRACT.md §4.1. Hand-written: schema/auth.ts is generated.
// Timestamps are ISO-8601 UTC TEXT (§1.4). The append-only triggers on control_audit_log live in
// a custom migration, because drizzle-kit does not model triggers.

export const WORKSPACE_STATUSES = [
  'provisioning',
  'active',
  'migrating',
  'failed',
  'suspended',
  'deleting',
] as const;

export const MIGRATION_RUN_STATUSES = [
  'pending',
  'running',
  'succeeded',
  'failed',
  'skipped',
] as const;

export const workspaceRegistry = sqliteTable(
  'workspace_registry',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .unique()
      .references(() => organization.id, { onDelete: 'restrict' }),
    databaseName: text('database_name').notNull().unique(),
    databaseUrl: text('database_url').notNull(),
    dbTokenCiphertext: text('db_token_ciphertext'),
    schemaVersion: integer('schema_version').notNull().default(0),
    status: text('status', { enum: WORKSPACE_STATUSES }).notNull().default('provisioning'),
    statusDetail: text('status_detail'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    /** The provisioning attempt that holds the row's claim; only it writes the row (§7.2). */
    attemptId: text('attempt_id'),
  },
  () => [
    check(
      'workspace_registry_status_check',
      sql`status IN ('provisioning','active','migrating','failed','suspended','deleting')`,
    ),
  ],
);

export const workspaceMemberSettings = sqliteTable(
  'workspace_member_settings',
  {
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    timezone: text('timezone').notNull().default('UTC'),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.organizationId, table.userId] })],
);

export const migrationRuns = sqliteTable(
  'migration_runs',
  {
    id: text('id').primaryKey(),
    batchId: text('batch_id').notNull(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaceRegistry.id, { onDelete: 'cascade' }),
    fromVersion: integer('from_version').notNull(),
    toVersion: integer('to_version').notNull(),
    status: text('status', { enum: MIGRATION_RUN_STATUSES }).notNull(),
    error: text('error'),
    startedAt: text('started_at'),
    finishedAt: text('finished_at'),
  },
  (table) => [
    check(
      'migration_runs_status_check',
      sql`status IN ('pending','running','succeeded','failed','skipped')`,
    ),
    index('idx_migration_runs_batch').on(table.batchId, table.status),
    index('idx_migration_runs_workspace').on(table.workspaceId, sql`started_at DESC`),
  ],
);

// No foreign keys: rows must outlive the users, organizations and workspaces they describe.
export const controlAuditLog = sqliteTable(
  'control_audit_log',
  {
    id: text('id').primaryKey(),
    actorUserId: text('actor_user_id'),
    organizationId: text('organization_id'),
    action: text('action').notNull(),
    targetType: text('target_type').notNull(),
    targetId: text('target_id').notNull(),
    beforeJson: text('before_json'),
    afterJson: text('after_json'),
    occurredAt: text('occurred_at').notNull(),
  },
  (table) => [index('idx_control_audit_org_time').on(table.organizationId, sql`occurred_at DESC`)],
);
