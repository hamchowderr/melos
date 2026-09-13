import { readFileSync } from 'node:fs';
import { type Client, createClient } from '@libsql/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyWorkspaceMigrations,
  readSchemaVersion,
  readWorkspaceMigrations,
} from '../../src/server/db/workspace-migrations';

const AT = '2026-09-13T00:00:00.000Z';
const STAMPS = { created_at: AT, updated_at: AT };
const FK = 'FOREIGN KEY constraint failed';
const CHECK = 'CHECK constraint failed';
const clients: Client[] = [];

/** One connection, and no file for Windows to keep locked. */
function memoryDatabase(): Client {
  const client = createClient({ url: ':memory:' });
  clients.push(client);
  return client;
}

async function rows(client: Client, query: string) {
  return (await client.execute(query)).rows.map((row) => ({ ...row }));
}

/** The SQL blocks of each CONTRACT.md section whose heading matches, as validate.mjs reads them. */
function contractSql(heading: RegExp): string[] {
  return readFileSync('docs/CONTRACT.md', 'utf8')
    .replace(/\r\n/g, '\n')
    .split(/^(?=#{1,3} )/m)
    .filter((section) => heading.test(section))
    .map((section) => [...section.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1]).join('\n'));
}

/** SQL without comments or layout; quoted text stays intact. */
function normalizeSql(sql: unknown): string {
  const tokens = String(sql).match(/'(?:[^']|'')*'|"(?:[^"]|"")*"|(?:\s|--.*)+|[^\s'"-]+|-/g) ?? [];
  const space = (i: number) =>
    /[(),]$/.test(tokens[i - 1] ?? ',') || /^[(),]/.test(tokens[i + 1] ?? ',') ? '' : ' ';
  return tokens.map((token, i) => (/^(\s|--)/.test(token) ? space(i) : token)).join('');
}

/** One row per column, foreign key column and UNIQUE constraint of every table. */
const TABLE_PRAGMAS = [
  "SELECT m.name AS tbl, 'column' AS kind, p.* FROM sqlite_master m, pragma_table_info(m.name) p",
  "SELECT m.name AS tbl, 'foreign_key' AS kind, p.* FROM sqlite_master m, pragma_foreign_key_list(m.name) p",
  "SELECT m.name AS tbl, 'unique' AS kind, group_concat(i.name, ', ') AS columns FROM sqlite_master m, pragma_index_list(m.name) l, pragma_index_info(l.name) i WHERE l.origin = 'u' GROUP BY m.name, l.name",
];

/**
 * Every object but SQLite's own, keyed `<type> <name>`: its normalized SQL, which carries CHECKs and
 * partial-index filters, and for a table its TABLE_PRAGMAS rows (type, NOT NULL, default, key, actions).
 */
async function describeSchema(client: Client, include = (_: Record<string, unknown>) => true) {
  const schema: Record<string, string[]> = {};
  const objects = await rows(client, "SELECT * FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'");
  for (const { type, name, sql } of objects.filter(include)) {
    schema[`${type} ${name}`] = [`sql ${normalizeSql(sql)}`];
  }
  for (const query of TABLE_PRAGMAS) {
    for (const { tbl, ...row } of await rows(client, query)) {
      schema[`table ${tbl}`]?.push(JSON.stringify(row));
    }
  }
  for (const lines of Object.values(schema)) lines.sort();
  return schema;
}

afterAll(() => {
  for (const client of clients) client.close();
});

describe('TEN-004: workspace migration 1 creates the CONTRACT.md §4.2 schema', () => {
  /** The §4.2 objects of a database built from the CONTRACT.md DDL. */
  let contract: Record<string, string[]>;
  const migrated = memoryDatabase();
  const insert = (table: string, row: Record<string, string>) =>
    migrated.execute({
      sql: `INSERT INTO ${table} (${Object.keys(row).join(', ')}) VALUES (${Object.keys(row).map(() => '?')})`,
      args: Object.values(row),
    });

  beforeAll(async () => {
    const [partiesCatalog, rest] = contractSql(/^### [\d.]+ Workspace database\b/);
    const fromContract = memoryDatabase();
    await fromContract.executeMultiple(partiesCatalog);
    const declared = new Set(Object.keys(await describeSchema(fromContract)));
    // Every workspace index sits at the end of §4.3. An index belongs to its table, so version 1
    // holds the indexes on §4.2 tables; a §4.3 trigger stays with the §4.3 tables it reads.
    await fromContract.executeMultiple(rest);
    contract = await describeSchema(
      fromContract,
      ({ type, name, tbl_name }) =>
        declared.has(`${type} ${name}`) || (type === 'index' && declared.has(`table ${tbl_name}`)),
    );
    expect(await applyWorkspaceMigrations(migrated)).toEqual({ applied: [1], version: 1 });
  });

  it('holds exactly the §4.2 tables and the §4.3 indexes on them, as CONTRACT.md declares', async () => {
    const tables = Object.keys(contract).filter((key) => key.startsWith('table '));
    expect(tables.sort().join(' ').replaceAll('table ', '')).toBe(
      'artist_aliases composition_alt_titles composition_terms compositions contact_methods metadata_terms organizations parties party_identifiers party_society_affiliations people recording_artists recording_contributors recording_links recording_terms recordings release_tracks releases schema_migrations workspace_self_parties',
    );
    expect(Object.keys(contract)).toHaveLength(tables.length + 17);
    expect(await describeSchema(migrated)).toEqual(contract);
  });

  it('records version 1 as parties_catalog, which readSchemaVersion reads', async () => {
    const recorded = await rows(migrated, 'SELECT version, name FROM schema_migrations');
    expect(recorded).toEqual([{ version: 1, name: 'parties_catalog' }]);
    expect(await readSchemaVersion(migrated)).toBe(1);
  });

  it.each<[string, string | RegExp, string]>([
    ['table contact_methods', /\s+label\s+TEXT,/, ''],
    ['table organizations', /legal_name(\s+)TEXT NOT NULL/, 'legal_name$1TEXT'],
    ['table artist_aliases', "DEFAULT 'stage_name'", "DEFAULT 'aka'"],
    ['table recordings', 'ON DELETE RESTRICT', 'ON DELETE CASCADE'],
    ['table people', /, party_kind\)( REFERENCES parties\(id), party_kind/, ')$1'],
    ['table composition_alt_titles', /,\s+UNIQUE \(composition_id, title\)/, ''],
    ['table compositions', "GLOB 'T", "GLOB 't"],
    ['index uq_recordings_isrc', ' AND deleted_at IS NULL', ''],
    ['index idx_recordings_title', /^[\s\S]*$/, 'SELECT 1'],
  ])('reports a migration that alters %s', async (key, from, to) => {
    const [migration] = readWorkspaceMigrations();
    const target = new RegExp(`${key.replace(/^\w+/, (type) => type.toUpperCase())}\\s`);
    const statements = migration.statements.map((s) => (target.test(s) ? s.replace(from, to) : s));
    expect(statements).not.toEqual(migration.statements);
    const altered = memoryDatabase();
    await applyWorkspaceMigrations(altered, { migrations: [{ ...migration, statements }] });
    const { [key]: changed, ...others } = await describeSchema(altered);
    const { [key]: original, ...expected } = contract;
    expect(others).toEqual(expected);
    expect(changed).not.toEqual(original);
  });

  it('refuses an organization party as a person and as the writer self party', async () => {
    await migrated.execute('PRAGMA foreign_keys = ON');
    const organization = { id: 'org', party_kind: 'organization', display_name: 'Org', ...STAMPS };
    await insert('parties', organization);
    await expect(insert('people', { party_id: 'org', legal_name: 'Org' })).rejects.toThrow(FK);
    const self = (side: string, party_kind: string) =>
      insert('workspace_self_parties', { side, party_id: 'org', party_kind, updated_at: AT });
    await expect(self('writer', 'person')).rejects.toThrow(FK);
    await expect(self('writer', 'organization')).rejects.toThrow(CHECK);
    await self('publishing', 'organization');
  });

  it.each([
    ['recordings', 'isrc', 'US-DMO-26-00001', 'USDMO2600001'],
    ['compositions', 'iswc', 'T-900.000.001-0', 'T9000000010'],
  ])('%s.%s refuses %s and accepts %s', async (table, column, formatted, normalized) => {
    const song = (value: string) =>
      insert(table, { id: value, title: 'Song', [column]: value, ...STAMPS });
    await expect(song(formatted)).rejects.toThrow(CHECK);
    await song(normalized);
  });
});
