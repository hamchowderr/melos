import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import type { TenantContext } from '../../src/server/services/tenant-context';
import type { WorkspaceTransaction } from '../../src/server/services/workspace-write';

/** The Northstar Demo Catalog fixture (melos-73v): its demo date and the ids of its rows. */
export const NORTHSTAR: { demo: { date: string }; keys: Record<string, string> } = JSON.parse(
  readFileSync('docs/fixtures/northstar-demo.json', 'utf8'),
);

/** validate.mjs's catalog_search derivation as the SELECTs of its two INSERTs, so it writes nothing. */
const DERIVATION = (
  readFileSync('docs/fixtures/validate.mjs', 'utf8').match(/INSERT INTO catalog_search[^`]+/g) ?? []
).map((statement) => statement.replace(/^INSERT INTO catalog_search \([^)]*\)/, ''));
if (DERIVATION.length !== 2) throw new Error('validate.mjs no longer derives catalog_search');

/**
 * Seeds Northstar on its demo date and returns Jordan Taylor's owner tenant in it. Call it after
 * prepareWorkspaceServices, which mocks melos-control; the caller closes the workspace database.
 */
export async function seedNorthstarTenant(): Promise<TenantContext> {
  const { seedNorthstar } = await import('../../src/server/db/seed/northstar');
  const password = 'northstar-catalog-test-password';
  const seeded = await seedNorthstar({ password, seedDate: NORTHSTAR.demo.date });
  if (seeded.status !== 'seeded') throw new Error(`Northstar was ${seeded.status}`);
  const { organizationId, workspaceId } = seeded;
  const ids = { userId: NORTHSTAR.keys.usr_JORDAN, requestId: crypto.randomUUID() };
  return { ...ids, organizationId, workspaceId, workspaceRole: 'owner' };
}

/**
 * catalog_search's rows and validate.mjs's derivation over the whole catalog, each as sorted JSON
 * arrays, read on a workspace database or inside a transaction, for a test to compare (§4.3).
 */
export async function catalogSearchOf(database: Pick<WorkspaceTransaction, 'values'>) {
  const sorted = (rows: unknown[][]) => rows.map((row) => JSON.stringify(Array.from(row))).sort();
  const derived: unknown[][] = [];
  for (const select of DERIVATION) derived.push(...(await database.values(sql.raw(select))));
  const indexed = await database.values(sql`SELECT * FROM catalog_search`);
  return { indexed: sorted(indexed), derived: sorted(derived) };
}

/** The §6.5 warnings every Northstar song carries: no registrations or instrumental (RGT-010). */
export const northstarWarnings = (recordingId: string, compositionId: string) =>
  [
    ['NOT_REGISTERED_PRO', 'The composition is not registered with a PRO.'],
    ['NOT_REGISTERED_MLC', 'The composition is not registered with The MLC.'],
    ['NOT_REGISTERED_SOUNDEXCHANGE', 'Not registered with SoundExchange.'],
    ['NO_INSTRUMENTAL', 'The recording has no instrumental.'],
  ].map(([code, detail]) => ({ code, severity: 'warning', recordingId, compositionId, detail }));
