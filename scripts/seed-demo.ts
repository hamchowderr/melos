import { runAsMain, withControl } from './operator';

const USAGE = 'Usage: npm run db:seed-demo [-- [--date YYYY-MM-DD] [--replace]]';
const PASSWORD = 'MELOS_DEMO_PASSWORD';

/** A real calendar date written YYYY-MM-DD. */
function isCalendarDate(value: string): boolean {
  const at = Date.parse(value);
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(at) &&
    new Date(at).toISOString().startsWith(value)
  );
}

/**
 * Seeds the Northstar Demo Catalog (§8 phase 3) into the configured control database and a
 * workspace it provisions, for `--date` or today in America/Los_Angeles. With `--replace` it first
 * deletes an earlier Northstar seed, complete or partial, through Better Auth (ADR-030), signed in
 * with the seeded credential. Jordan Taylor's password is read from MELOS_DEMO_PASSWORD and never
 * printed. Prints `<organizationId> <workspaceId> <dateShift>`. Returns 0 once seeded; 1 when a
 * step fails, when the organization exists without `--replace`, which changes nothing, or when a
 * delete is refused, which seeds nothing; and 2 for a usage or configuration error.
 */
export async function runSeedDemoCommand(
  args: readonly string[],
  print: (line: string) => void = console.log,
): Promise<number> {
  const dated = args.filter((arg) => arg !== '--replace');
  const [flag, seedDate] = dated;
  const replace = args.length === dated.length + 1;
  const withDate = dated.length === 2 && flag === '--date' && isCalendarDate(seedDate);
  if ((dated.length !== 0 && !withDate) || args.length > dated.length + 1) {
    console.error(USAGE);
    return 2;
  }
  const password = process.env[PASSWORD] ?? '';
  if (password.length < 8 || password.length > 128) {
    console.error(`${PASSWORD} must be set to 8 to 128 characters`);
    return 2;
  }
  return withControl(async ({ env }) => {
    if (env.workspaceHost.kind === 'local' && !env.controlDatabase.url.startsWith('file:')) {
      console.error(
        'A remote control database needs the Vercel workspace host: set VERCEL and Turso',
      );
      return 2;
    }
    const { seedNorthstar } = await import('../src/server/db/seed/northstar');
    const seed = await seedNorthstar({ password, seedDate, replace });
    if (seed.status === 'exists') {
      console.error(
        `Organization ${seed.organizationId} already exists; nothing was changed (--replace replaces it)`,
      );
      return 1;
    }
    if (seed.status === 'refused') {
      const { organizationId, refusal } = seed;
      console.error(
        `Organization ${organizationId} was not replaced (${refusal}); nothing was seeded`,
      );
      // The seeded credential still holds the password the earlier seed hashed.
      if (refusal.startsWith('sign_in ')) {
        console.error(`Set ${PASSWORD} to the value the existing seed used, then run this again`);
      }
      return 1;
    }
    print(`${seed.organizationId} ${seed.workspaceId} ${seed.dateShift}`);
    return 0;
  });
}

await runAsMain(import.meta.url, runSeedDemoCommand);
