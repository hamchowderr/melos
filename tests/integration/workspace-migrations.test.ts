import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Client, createClient } from '@libsql/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  EMBEDDED_MIGRATIONS_FILE,
  generateEmbeddedMigrations,
} from '../../src/server/db/embed-workspace-migrations';
import { ensureLocalDatabaseDir } from '../../src/server/db/local-database';
import {
  applyWorkspaceMigrations,
  readWorkspaceMigrations,
  WORKSPACE_MIGRATIONS,
} from '../../src/server/db/workspace-migrations';
import { EMBEDDED_WORKSPACE_MIGRATIONS } from '../../src/server/db/workspace-migrations.generated';
import { addPitchOwner, generateFromChangedCopy, replaceIn } from './changed-migrations';

const folders: string[] = [];
const clients: Client[] = [];

type Files = Record<string, string[]>;

/** A temp migrations folder: each file holds its statements joined by the breakpoint. */
function migrationsFolder(files: Files): string {
  const folder = mkdtempSync(join(tmpdir(), 'melos-ws-migrations-'));
  folders.push(folder);
  for (const [file, statements] of Object.entries(files)) {
    writeFileSync(join(folder, file), statements.join('\n--> statement-breakpoint\n'));
  }
  return folder;
}

/** A fresh local libSQL file, removed before use and never after: Windows keeps it locked. */
function freshDatabase(name: string): Client {
  const file = `data/test-workspace-migrations-${name}.db`;
  for (const suffix of ['', '-shm', '-wal']) rmSync(`${file}${suffix}`, { force: true });
  const url = `file:./${file}`;
  ensureLocalDatabaseDir(url);
  const client = createClient({ url });
  clients.push(client);
  return client;
}

/** Reads the folder inside the promise, so a refused folder rejects like a failed migration. */
async function migrate(client: Client, files: Files, applied: number[] = []) {
  return applyWorkspaceMigrations(client, {
    migrations: readWorkspaceMigrations(migrationsFolder(files)),
    onApplied: ({ version }) => {
      applied.push(version);
    },
  });
}

async function rows(client: Client, query: string) {
  return (await client.execute(query)).rows.map((row) => ({ ...row }));
}

const objects = (client: Client) =>
  rows(client, "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name");

const ARTISTS: Files = {
  '0001_artists.sql': [
    'CREATE TABLE artists (id TEXT PRIMARY KEY, name TEXT NOT NULL)',
    "INSERT INTO artists (id, name) VALUES ('a1', 'Ada')",
  ],
};
// Indexes the version 1 table, so it applies only after version 1.
const TWO_VERSIONS: Files = {
  ...ARTISTS,
  '0002_artist_names.sql': ['CREATE INDEX idx_artists_name ON artists (name)'],
};
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

afterAll(() => {
  for (const client of clients) client.close();
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
});

describe('TEN-003: numbered workspace migrations apply once and record schema_migrations', () => {
  let db: Client;

  beforeAll(() => {
    db = freshDatabase('two-versions');
  });

  it('applies a two-version folder to a fresh file in order and reports version 2', async () => {
    const applied: number[] = [];
    expect(await migrate(db, TWO_VERSIONS, applied)).toEqual({ applied: [1, 2], version: 2 });
    expect(applied).toEqual([1, 2]);
    expect(await rows(db, 'SELECT * FROM schema_migrations ORDER BY version')).toEqual([
      { version: 1, name: 'artists', applied_at: expect.stringMatching(ISO_TIMESTAMP) },
      { version: 2, name: 'artist_names', applied_at: expect.stringMatching(ISO_TIMESTAMP) },
    ]);
    expect(await objects(db)).toEqual([
      { type: 'table', name: 'artists' },
      { type: 'index', name: 'idx_artists_name' },
      { type: 'table', name: 'schema_migrations' },
    ]);
  });

  it('applies nothing on a second run and still reports version 2', async () => {
    const before = await rows(db, 'SELECT * FROM schema_migrations ORDER BY version');
    const applied: number[] = [];
    expect(await migrate(db, TWO_VERSIONS, applied)).toEqual({ applied: [], version: 2 });
    expect(applied).toEqual([]);
    expect(await rows(db, 'SELECT * FROM schema_migrations ORDER BY version')).toEqual(before);
    expect(await rows(db, 'SELECT count(*) AS n FROM artists')).toEqual([{ n: 1 }]);
  });

  it('refuses a database newer than the latest migration', async () => {
    await expect(migrate(db, ARTISTS)).rejects.toThrow(
      'Workspace database is at version 2, newer than the latest migration 1',
    );
  });

  it('rolls back only a failing version, records nothing for it and names the version and file', async () => {
    const failing = freshDatabase('failing-version');
    const applied: number[] = [];
    const broken = [
      'CREATE TABLE tracks (id TEXT PRIMARY KEY)',
      'INSERT INTO missing (id) VALUES (1)',
    ];
    await expect(
      migrate(failing, { ...ARTISTS, '0002_tracks.sql': broken }, applied),
    ).rejects.toThrow(
      /^Workspace migration 2 \(0002_tracks\.sql\) failed at statement 2: .*no such table: missing/,
    );
    expect(applied).toEqual([1]);
    expect(await rows(failing, 'SELECT version FROM schema_migrations')).toEqual([{ version: 1 }]);
    expect(await objects(failing)).toEqual([
      { type: 'table', name: 'artists' },
      { type: 'table', name: 'schema_migrations' },
    ]);

    const fixed = { ...ARTISTS, '0002_tracks.sql': broken.slice(0, 1) };
    expect(await migrate(failing, fixed)).toEqual({ applied: [2], version: 2 });
  });

  it.each([
    [
      'a gap',
      { '0003_tracks.sql': ['SELECT 1'] },
      '0003_tracks.sql leaves a gap: expected version 2',
    ],
    [
      'a duplicate number',
      { '0001_tracks.sql': ['SELECT 1'] },
      '0001_artists.sql and 0001_tracks.sql share version 1',
    ],
    [
      'a misnamed file',
      { '0002-tracks.sql': ['SELECT 1'] },
      '0002-tracks.sql is not named NNNN_<name>.sql',
    ],
  ])('refuses a folder with %s before any statement runs', async (flaw, extra, message) => {
    const refused = freshDatabase(`refused-${flaw.replaceAll(' ', '-')}`);
    await expect(migrate(refused, { ...ARTISTS, ...extra })).rejects.toThrow(message);
    expect(await objects(refused)).toEqual([]);
  });

  it('applies a trigger whose body contains semicolons intact', async () => {
    const withTrigger = freshDatabase('trigger');
    const trigger = [
      'CREATE TRIGGER artists_renamed AFTER UPDATE OF name ON artists',
      'BEGIN',
      "  INSERT INTO artist_events (artist_id, event) VALUES (OLD.id, 'from ' || OLD.name);",
      "  INSERT INTO artist_events (artist_id, event) VALUES (NEW.id, 'to ' || NEW.name);",
      'END',
    ].join('\n');
    const files = {
      ...ARTISTS,
      '0002_artist_events.sql': [
        'CREATE TABLE artist_events (artist_id TEXT NOT NULL, event TEXT NOT NULL)',
        `${trigger};`,
      ],
    };
    expect(await migrate(withTrigger, files)).toEqual({ applied: [1, 2], version: 2 });
    expect(await rows(withTrigger, "SELECT sql FROM sqlite_master WHERE type = 'trigger'")).toEqual(
      [{ sql: trigger }],
    );

    await withTrigger.execute("UPDATE artists SET name = 'Ada Lovelace' WHERE id = 'a1'");
    expect(await rows(withTrigger, 'SELECT event FROM artist_events ORDER BY rowid')).toEqual([
      { event: 'from Ada' },
      { event: 'to Ada Lovelace' },
    ]);
  });
});

describe('melos-75e.18: runtime code applies the migrations embedded from the SQL folder', () => {
  const committed = readFileSync(EMBEDDED_MIGRATIONS_FILE, 'utf8');
  const STALE = `${EMBEDDED_MIGRATIONS_FILE} does not match ${WORKSPACE_MIGRATIONS}: run npm run db:workspace-migrations`;

  /** The parity check: the committed module holds exactly `folder`'s migrations, as generated. */
  function expectEmbedded(folder = WORKSPACE_MIGRATIONS) {
    expect(EMBEDDED_WORKSPACE_MIGRATIONS, STALE).toEqual(readWorkspaceMigrations(folder));
    expect(generateEmbeddedMigrations(folder), STALE).toBe(committed);
  }

  it('embeds every migration of the SQL folder and nothing else, byte for byte', () => {
    expectEmbedded();
  });

  it.each([
    ['added', addPitchOwner],
    ['removed', (folder: string) => rmSync(join(folder, '0005_samples_exclusivity.sql'))],
    ['edited', replaceIn('0001_parties_catalog.sql', "DEFAULT 'stage_name'", "DEFAULT 'aka'")],
  ])('fails, naming the npm script, when a migration is %s in the folder', async (_, change) => {
    const refused = async (folder: string) => {
      expect(() => expectEmbedded(folder)).toThrow(STALE);
      return 'refused';
    };
    expect(await generateFromChangedCopy(WORKSPACE_MIGRATIONS, change, refused)).toBe('refused');
  });
});
