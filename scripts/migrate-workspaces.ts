import { ulid } from 'ulid';
import type { MigrationBatchResult } from '../src/server/db/migration-runner';
import { errorCode } from '../src/server/error-code';
import { runAsMain, withControl } from './operator';

const USAGE = 'Usage: npm run db:migrate-workspaces [-- <batchId>]';
const BATCH_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * Runs a new MigrationRunner batch (§7.2, ADR-033) or, given its id, reruns one, against one
 * environment's control database. Prints `batch <batchId>`, then `<workspaceId> <from> <to> <status>
 * <error>` per workspace, where the error is a name and code or `-`, never a token, URL or message.
 * Returns 0 only when every workspace ends `succeeded` or `skipped`, at the target version; 1 when
 * one is `unclaimed` or `failed`, which can leave it active below the target, or the batch stops;
 * and 2 for a usage or configuration error, including an unconfigured workspace host.
 */
export async function runMigrateCommand(
  args: readonly string[],
  print: (line: string) => void = console.log,
): Promise<number> {
  const [given] = args;
  if (args.length > 1 || (given !== undefined && !BATCH_ID.test(given))) {
    console.error(USAGE);
    return 2;
  }
  const batchId = given ?? ulid();
  return withControl(async ({ env }) => {
    if (env.workspaceHost.kind === 'local' && !env.controlDatabase.url.startsWith('file:')) {
      console.error(
        'A remote control database needs the Vercel workspace host: set VERCEL and Turso',
      );
      return 2;
    }
    const { runMigrationBatch } = await import('../src/server/db/migration-runner');
    const { WorkspaceHostConfigError } = await import('../src/server/db/workspace-hosts');
    let result: MigrationBatchResult;
    try {
      result = await runMigrationBatch({ batchId });
    } catch (error) {
      // The runner refuses an unconfigured host before writing; its message names variables only.
      const refused = error instanceof WorkspaceHostConfigError;
      console.error(
        refused ? error.message : `Migration batch ${batchId} stopped: ${errorCode(error)}`,
      );
      return refused ? 2 : 1;
    }
    print(`batch ${batchId}`);
    for (const { workspaceId, fromVersion, toVersion, status, error } of result.workspaces) {
      print(`${workspaceId} ${fromVersion} ${toVersion} ${status} ${error ?? '-'}`);
    }
    // An active workspace can still be below the target when its claim was not won.
    const done = ({ status }: { status: string }) => status === 'succeeded' || status === 'skipped';
    return result.workspaces.every(done) ? 0 : 1;
  });
}

await runAsMain(import.meta.url, runMigrateCommand);
