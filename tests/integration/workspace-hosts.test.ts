import { randomBytes } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { createClient } from '@libsql/client';
import { ulid } from 'ulid';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createTokenCipher } from '../../src/server/db/token-cipher';
import { createWorkspaceHost, TursoApiError } from '../../src/server/db/workspace-hosts';

const DATA_DIR = '.data/test-workspace-hosts';
const API_TOKEN = 'platform-api-token-for-tests';
const JWT = 'database-jwt-for-tests';
const TOKEN_KEY = randomBytes(32).toString('base64');
const DATABASES = 'https://api.turso.tech/v1/organizations/example-org/databases';

type Call = { method: string; url: string; authorization: string; body: unknown };
type Reply = [status: number, payload: unknown];
type Respond = (call: Call) => Reply;

/** A Turso Platform API stub behind an injected fetch: no request leaves the process. */
function stubTurso(respond: Respond) {
  const calls: Call[] = [];
  const setting = { apiToken: API_TOKEN, organization: 'example-org', group: 'default' };
  const host = createWorkspaceHost(
    { kind: 'turso', ...setting, tokenKey: TOKEN_KEY },
    async (url, init) => {
      const { authorization } = init.headers as Record<string, string>;
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      const call = { method: String(init.method), url, authorization, body };
      calls.push(call);
      const [status, payload] = respond(call);
      return Response.json(payload, { status });
    },
  );
  return { calls, host };
}

const newName = () => `melos-ws-${ulid()}`;
const hostnameOf = (name: string) => `${name.toLowerCase()}-example-org.turso.io`;
const found = (name: string): Reply => [200, { database: { Hostname: hostnameOf(name) } }];

beforeAll(() => rmSync(DATA_DIR, { recursive: true, force: true }));

describe('local workspace host', () => {
  it('creates an openable libSQL file named melos-ws-<ulid>.db in the data dir and deletes it', async () => {
    const host = createWorkspaceHost({ kind: 'local', dataDir: DATA_DIR });
    const name = newName();
    const file = `${DATA_DIR}/${name}.db`;
    const expected = { url: `file:${file}`, tokenCiphertext: null };

    expect(await host.create(name)).toEqual(expected);
    expect(existsSync(file)).toBe(true);
    await host.delete(name);
    expect(existsSync(file)).toBe(false);
    await host.delete(name);

    // A file opened here stays locked on Windows until this process exits, so it is not deleted.
    expect(await host.create(name)).toEqual(expected);
    const client = createClient({ url: expected.url });
    await client.execute('CREATE TABLE probe (id TEXT PRIMARY KEY)');
    expect(await host.create(name)).toEqual(expected);
    const tables = await client.execute("SELECT name FROM sqlite_master WHERE type = 'table'");
    expect(tables.rows.map((row) => row.name)).toEqual(['probe']);
    client.close();
    await expect(host.create('../melos-ws-escape')).rejects.toThrow('Invalid workspace database');
  });
});

describe('Turso workspace host', () => {
  it('creates the database, mints a full-access token and returns the URL and encrypted jwt', async () => {
    const name = newName();
    const lower = name.toLowerCase();
    const { calls, host } = stubTurso(({ method, url }) => {
      if (url === DATABASES) return found(name);
      return method === 'POST' ? [200, { jwt: JWT }] : [200, { database: lower }];
    });

    const database = await host.create(name);
    expect(database.url).toBe(`libsql://${hostnameOf(name)}`);
    expect(database.tokenCiphertext).not.toContain(JWT);
    expect(createTokenCipher(TOKEN_KEY).decrypt(String(database.tokenCiphertext), name)).toBe(JWT);
    await host.delete(name);

    const sent = calls.map(({ method, url, body }) => [method, url.replace(DATABASES, ''), body]);
    expect(sent).toEqual([
      ['POST', '', { name: lower, group: 'default' }],
      ['POST', `/${lower}/auth/tokens?expiration=never&authorization=full-access`, undefined],
      ['DELETE', `/${lower}`, undefined],
    ]);
    expect(calls.map((call) => call.authorization)).toEqual(Array(3).fill(`Bearer ${API_TOKEN}`));
  });

  it('reuses a database that already exists and treats a missing one as deleted', async () => {
    const name = newName();
    const { calls, host } = stubTurso(({ method, url }) => {
      if (url === DATABASES) return [409, { error: 'database already exists' }];
      if (method === 'POST') return [200, { jwt: JWT }];
      return method === 'GET' ? found(name) : [404, { error: 'database not found' }];
    });

    expect((await host.create(name)).url).toBe(`libsql://${hostnameOf(name)}`);
    await host.delete(name);
    expect(calls.map(({ method }) => method)).toEqual(['POST', 'GET', 'POST', 'DELETE']);
  });

  it('raises TursoApiError with no token in its message or fields and logs nothing', async () => {
    const levels = ['log', 'info', 'warn', 'error', 'debug'] as const;
    const logs = levels.map((level) => vi.spyOn(console, level));
    const name = newName();
    const onToken =
      (reply: Reply): Respond =>
      ({ url }) =>
        url === DATABASES ? found(name) : reply;
    const scenarios: [Respond, string][] = [
      [() => [401, { error: API_TOKEN }], 'create database 401 http_error'],
      [onToken([500, { error: JWT }]), 'create token 500 http_error'],
      [onToken([200, {}]), 'create token 200 bad_response'],
      [
        () => {
          throw new Error(API_TOKEN);
        },
        'create database 0 unreachable',
      ],
    ];

    for (const [respond, expected] of scenarios) {
      const { host } = stubTurso(respond);
      const error = await host.create(name).catch((caught: unknown) => caught);
      if (!(error instanceof TursoApiError)) throw new Error('expected a TursoApiError');
      expect(`${error.operation} ${error.status} ${error.code}`).toBe(expected);
      const exposed = JSON.stringify({ ...error, message: error.message, stack: error.stack });
      for (const secret of [API_TOKEN, JWT, TOKEN_KEY]) expect(exposed).not.toContain(secret);
    }
    for (const log of logs) expect(log).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
