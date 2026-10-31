import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
} from 'drizzle-orm/sqlite-core';

// melos-agent-runtime runner tables (docs/CONTRACT.md §4.1, §7.9). Hand-written from
// migrations/runtime; tests/integration/runtime-database.test.ts compares them with the migrated
// schema. Timestamps are ISO-8601 UTC TEXT (§1.4).

export const AGENT_RUN_STATUSES = ['finished', 'interrupted', 'error', 'stopped'] as const;
export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];

export const agentThreads = sqliteTable(
  'agent_threads',
  {
    threadId: text('thread_id').primaryKey(),
    resourceId: text('resource_id').notNull(),
    workspaceId: text('workspace_id').notNull(),
    agentId: text('agent_id').notNull(),
    activeRunId: text('active_run_id'),
    runInstanceId: text('run_instance_id'),
    runHeartbeatAt: text('run_heartbeat_at'),
    stopRequestedAt: text('stop_requested_at'),
    nextRunSeq: integer('next_run_seq').notNull().default(1),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('idx_agent_threads_resource').on(table.resourceId, sql`${table.updatedAt} DESC`),
    index('idx_agent_threads_workspace').on(table.workspaceId),
    check(
      'agent_threads_run_owner',
      sql`(${table.activeRunId} IS NULL) = (${table.runInstanceId} IS NULL)`,
    ),
  ],
);

export const agentThreadRuns = sqliteTable(
  'agent_thread_runs',
  {
    threadId: text('thread_id')
      .notNull()
      .references(() => agentThreads.threadId, { onDelete: 'cascade' }),
    runId: text('run_id').notNull(),
    seq: integer('seq').notNull(),
    parentRunId: text('parent_run_id'),
    status: text('status', { enum: AGENT_RUN_STATUSES }).notNull(),
    eventsJson: text('events_json').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.threadId, table.runId] }),
    unique().on(table.threadId, table.seq),
  ],
);
