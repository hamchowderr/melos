import { rmSync } from 'node:fs';
import { LLMock } from '@copilotkit/aimock';
import { type Client, createClient } from '@libsql/client';
import { sql } from 'drizzle-orm';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import { expect } from 'vitest';

export const BASE_URL = 'http://localhost:3100';

type Transaction = Parameters<Parameters<LibSQLDatabase['transaction']>[0]>[0];

/**
 * DAT-INT-001: an in-memory database with foreign-key enforcement off, so IntegrityGuard and not
 * SQLite keeps it consistent (CONTRACT §4.4). Its one connection carries the pragma into every
 * transaction. `prepare` runs first, because drizzle's migrator turns enforcement back on.
 */
export async function openWithoutForeignKeys(
  prepare: (db: LibSQLDatabase) => Promise<unknown>,
): Promise<LibSQLDatabase & { $client: Client }> {
  const db = drizzle(createClient({ url: ':memory:' }));
  await prepare(db);
  await db.run(sql`PRAGMA foreign_keys = OFF`);
  return db;
}

/**
 * DAT-INT-001: runs `operation` in one transaction, then expects PRAGMA foreign_key_check to report
 * no rows, whether the transaction committed or a refusal rolled it back.
 */
export async function expectForeignKeysIntact<T>(
  db: LibSQLDatabase,
  operation: (tx: Transaction) => Promise<T>,
): Promise<T> {
  try {
    return await db.transaction(async (tx) => {
      expect(await tx.all(sql`PRAGMA foreign_keys`)).toEqual([{ foreign_keys: 0 }]);
      return operation(tx);
    });
  } finally {
    expect(await db.all(sql`PRAGMA foreign_key_check`)).toEqual([]);
  }
}

type Handler = (request: Request) => Promise<Response> | Response;

/**
 * Starts an in-process AIMock and gives this test file its own fresh libSQL files. Call it
 * before importing any app module: the env is read once, when those modules load.
 */
export async function prepareTestEnvironment(name: string): Promise<LLMock> {
  const mock = new LLMock({ port: 0 });
  mock.loadFixtureDir('fixtures/aimock');
  const url = await mock.start();
  process.env.MELOS_LLM_BASE_URL = `${url.replace(/\/$/, '')}/v1`;

  const control = `data/test-${name}-control.db`;
  const agent = `data/test-${name}-agent.db`;
  for (const file of [control, agent]) {
    for (const suffix of ['', '-shm', '-wal']) rmSync(`${file}${suffix}`, { force: true });
  }
  process.env.MELOS_CONTROL_DATABASE_URL = `file:./${control}`;
  process.env.MELOS_AGENT_DATABASE_URL = `file:./${agent}`;
  const workspaces = `data/test-${name}-workspaces`;
  rmSync(workspaces, { recursive: true, force: true });
  process.env.MELOS_WORKSPACE_DATA_DIR = workspaces;

  const { migrate } = await import('drizzle-orm/libsql/migrator');
  const { controlDb } = await import('../../src/server/db/client');
  await migrate(controlDb, { migrationsFolder: './src/server/db/migrations/control' });
  return mock;
}

/** A browser-like client for route handlers: keeps cookies across calls. */
export class TestClient {
  cookie = '';
  /** Sent with every call; cannot replace the origin, content type or cookie. */
  extraHeaders: Record<string, string> = {};

  async call(handler: Handler, method: string, path: string, body?: unknown): Promise<Response> {
    const response = await handler(
      new Request(`${BASE_URL}${path}`, {
        method,
        headers: {
          ...this.extraHeaders,
          origin: BASE_URL,
          'content-type': 'application/json',
          ...(this.cookie ? { cookie: this.cookie } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    this.store(response.headers.getSetCookie());
    return response;
  }

  headers(): Headers {
    return new Headers(this.cookie ? { cookie: this.cookie } : {});
  }

  private store(setCookies: string[]): void {
    if (setCookies.length === 0) return;
    const jar = new Map(
      this.cookie
        .split('; ')
        .filter(Boolean)
        .map((pair) => pair.split(/=(.*)/s).slice(0, 2) as [string, string]),
    );
    for (const setCookie of setCookies) {
      const [pair = ''] = setCookie.split(';');
      const [name = '', value = ''] = pair.split(/=(.*)/s);
      jar.set(name, value);
    }
    this.cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
  }
}

export type AgUiEvent = { type: string; content?: string; toolCallName?: string; message?: string };

/** Parses the AG-UI server-sent event stream returned by the CopilotKit runtime. */
export async function readAgUiEvents(response: Response): Promise<AgUiEvent[]> {
  return (await response.text())
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => JSON.parse(line.slice('data:'.length).trim()) as AgUiEvent);
}
