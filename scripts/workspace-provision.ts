import { eq, inArray } from 'drizzle-orm';
import { workspaceRegistry } from '../src/server/db/schema/control';
import { runAsMain, withControl } from './operator';

const USAGE =
  'Usage: npm run workspace:provision -- <organizationId> | --all-failed (failed or stale provisioning)';

/**
 * Retries workspace provisioning (§7.2, P-23) for one organization or, with `--all-failed`, every
 * failed workspace and every provisioning one whose claim is stale, one at a time. Prints
 * `<organizationId> <status>` per workspace and never a token, error message or status_detail.
 * Returns 0 when every workspace is active, 1 when one is not or a query fails, and 2 for a usage or
 * configuration error (ADR-032).
 */
export async function runProvisionCommand(
  args: readonly string[],
  print: (line: string) => void = console.log,
): Promise<number> {
  const [target = ''] = args;
  if (args.length !== 1 || target === '' || (target.startsWith('-') && target !== '--all-failed')) {
    console.error(USAGE);
    return 2;
  }
  return withControl(async ({ env, controlDb }) => {
    if (env.workspaceHost.kind === 'local' && !env.controlDatabase.url.startsWith('file:')) {
      console.error(
        'A remote control database needs the Vercel workspace host: set VERCEL and Turso',
      );
      return 2;
    }
    const { claimable, provisionWorkspace } = await import(
      '../src/server/services/workspace-provisioner'
    );
    const retryable = inArray(workspaceRegistry.status, ['failed', 'provisioning']);
    const rows = await controlDb
      .select()
      .from(workspaceRegistry)
      .where(retryable)
      .orderBy(workspaceRegistry.id);
    // A provisioning row under a live claim is left to the attempt that may still be running it.
    const organizationIds =
      target === '--all-failed'
        ? rows.filter(claimable).map((row) => row.organizationId)
        : [target];
    let exitCode = 0;
    for (const organizationId of organizationIds) {
      // The error names the step and code, as status_detail does; print the status read back instead.
      await provisionWorkspace(organizationId).catch(() => undefined);
      const byOrganization = eq(workspaceRegistry.organizationId, organizationId);
      const [row] = await controlDb.select().from(workspaceRegistry).where(byOrganization);
      const status = row?.status ?? 'missing';
      print(`${organizationId} ${status}`);
      if (status !== 'active') exitCode = 1;
    }
    return exitCode;
  });
}

await runAsMain(import.meta.url, runProvisionCommand);
