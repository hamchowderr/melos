import { sql } from 'drizzle-orm';
import { getRuntimeDatabase, type RuntimeDatabase } from '../db/runtime-database';
import { agentThreads } from '../db/schema/runtime';
import { runtimeIntegrityGuard } from '../services/integrity-guard';

/** `LIKE` matches `<workspaceId>:` literally: `%`, `_` and the escape character are escaped. */
const prefixPattern = (workspaceId: string) => `${workspaceId.replace(/[\\%_]/g, '\\$&')}:%`;

/**
 * Deletes everything melos-agent-runtime holds for one workspace (§7.2, §7.3): Mastra threads,
 * their messages and state, working memory, and the runner's agent_threads rows, whose
 * agent_thread_runs cascade through IntegrityGuard (DAT-001). Every row is matched by a resource id
 * starting with `<workspaceId>:` or by a thread of such a resource. One transaction, so a failure
 * leaves nothing half deleted and the organization delete can run again.
 */
export async function deleteWorkspaceAgentMemory(
  workspaceId: string,
  database: () => Promise<RuntimeDatabase> = getRuntimeDatabase,
): Promise<void> {
  const db = await database();
  const pattern = prefixPattern(workspaceId);
  const owned = sql`"resourceId" LIKE ${pattern} ESCAPE '\\'`;
  const threads = sql`SELECT id FROM mastra_threads WHERE ${owned}`;
  await db.transaction(async (tx) => {
    // Mastra creates its tables on first use; a database that never ran an agent has none.
    const { rows } = await tx.run(
      sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('mastra_threads', 'mastra_messages', 'mastra_resources', 'mastra_thread_state')`,
    );
    const tables = new Set(rows.map((row) => String(row.name)));
    if (tables.has('mastra_messages')) {
      await tx.run(sql`DELETE FROM mastra_messages WHERE thread_id IN (${threads}) OR ${owned}`);
    }
    if (tables.has('mastra_thread_state')) {
      await tx.run(sql`DELETE FROM mastra_thread_state WHERE "threadId" IN (${threads})`);
    }
    if (tables.has('mastra_threads')) await tx.run(sql`DELETE FROM mastra_threads WHERE ${owned}`);
    if (tables.has('mastra_resources')) {
      await tx.run(sql`DELETE FROM mastra_resources WHERE id LIKE ${pattern} ESCAPE '\\'`);
    }
    await runtimeIntegrityGuard.delete(
      tx,
      agentThreads,
      sql`${agentThreads.workspaceId} = ${workspaceId}`,
    );
  });
}
