import type { Client } from '@libsql/client';
import { eq } from 'drizzle-orm';
import { workspaceRegistry } from '../src/server/db/schema/control';
import { runAsMain, withControl } from './operator';

const USAGE = 'Usage: npm run db:validate-demo';

/**
 * Proves the seeded Northstar Demo Catalog meets every DEMO-001 to DEMO-010 precondition (§5.6) and
 * the §6.5 readiness table (§8 phase 3): runs docs/fixtures/validate.mjs's checks against the
 * configured control database and the Northstar workspace, opened as provisioning opens it, with
 * any Turso token decrypted by MELOS_WORKSPACE_TOKEN_KEY. EXPECTED.md holds demo-date values, so the
 * seed must be for 2026-09-14. Prints `FAIL [<group>] <check>` with the compared values per failed
 * check, then `<n> assertions, <m> failed`, and never a token or database URL. Returns 0 when every
 * check passes; 1 when one fails, Northstar has no workspace or a query fails; and 2 for a usage or
 * configuration error.
 */
export async function runValidateDemoCommand(
  args: readonly string[],
  print: (line: string) => void = console.log,
): Promise<number> {
  if (args.length !== 0) {
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
    const hosts = await import('../src/server/db/workspace-hosts');
    const { fixture, validateSeeded } = await import('../docs/fixtures/validate.mjs');
    const organizationId = fixture.keys[fixture.demo.organization];
    const byOrganization = eq(workspaceRegistry.organizationId, organizationId);
    const [row] = await controlDb.select().from(workspaceRegistry).where(byOrganization);
    if (!row) {
      console.error(`Organization ${organizationId} has no workspace; run npm run db:seed-demo`);
      return 1;
    }
    let workspace: Client;
    try {
      workspace = hosts.openWorkspaceDatabase(env.workspaceHost, row);
    } catch (error) {
      if (!(error instanceof hosts.WorkspaceHostConfigError)) throw error;
      console.error(error.message);
      return 2;
    }
    try {
      const { assertions, failures } = await validateSeeded(controlDb.$client, workspace);
      for (const { group, label, expected, actual } of failures) {
        print(`FAIL [${group}] ${label}\n  expected: ${expected}\n  actual:   ${actual}`);
      }
      print(`${assertions} assertions, ${failures.length} failed`);
      return failures.length === 0 ? 0 : 1;
    } finally {
      workspace.close();
    }
  });
}

await runAsMain(import.meta.url, runValidateDemoCommand);
