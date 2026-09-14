import { Console } from 'node:console';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { inspect } from 'node:util';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import type { LLMock } from '@copilotkit/aimock';
import type { Client } from '@libsql/client';
import { eq, sql } from 'drizzle-orm';
import { ulid } from 'ulid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { workspaceRegistry } from '../../src/server/db/schema/control';
import { compositions } from '../../src/server/db/schema/workspace.generated';
import type { WorkspaceHostSetting } from '../../src/server/env';
import { prepareTestEnvironment, readAgUiEvents, TestClient } from './support';

type Handler = (request: Request) => Promise<Response>;
type Row = typeof workspaceRegistry.$inferSelect;
type Libsql = typeof import('@libsql/client');
type Store = typeof import('@mastra/libsql');
type Ping = typeof import('../../src/mastra/tools/ping');
type Execute = (input: unknown, context: { requestContext: Map<string, unknown> }) => unknown;

const DATA_DIR = 'data/test-connections-workspaces';
const RUN_PATH = '/api/copilotkit/agent/melos/run';
const TOKEN = 'stub-workspace-jwt-that-must-never-be-shown';
const TOKEN_KEY = Buffer.alloc(32, 9).toString('base64');
const TURSO_HOST: WorkspaceHostSetting = {
  kind: 'turso',
  apiToken: 'stub',
  organization: 'stub',
  group: 'default',
  tokenKey: TOKEN_KEY,
};
const stamp = Date.now();
const createClient = vi.fn<Libsql['createClient']>();
const storageConfigs: unknown[] = [];
const toolCalls: Record<string, unknown>[] = [];
let mock: LLMock;
let authRoute: { POST: Handler };
let copilotRoute: { POST: Handler };
let db: typeof import('../../src/server/db/client');
let env: ReturnType<typeof import('../../src/server/env').getServerEnv>;
let resolver: typeof import('../../src/server/services/tenant-context').tenantContextResolver;
let connections: typeof import('../../src/server/services/workspace-connections');
let provisioner: typeof import('../../src/server/services/workspace-provisioner');
let hosts: typeof import('../../src/server/db/workspace-hosts');
let cipher: typeof import('../../src/server/db/token-cipher');

beforeAll(async () => {
  // Records every libSQL client, the Mastra storage config and each ping call.
  vi.doMock('@libsql/client', async (importOriginal) => {
    const libsql = await importOriginal<Libsql>();
    return { ...libsql, createClient: createClient.mockImplementation(libsql.createClient) };
  });
  vi.doMock('@mastra/libsql', async (importOriginal) => {
    const store = await importOriginal<Store>();
    class LibSQLStore extends store.LibSQLStore {
      constructor(config: ConstructorParameters<Store['LibSQLStore']>[0]) {
        super(config);
        storageConfigs.push(config);
      }
    }
    return { ...store, LibSQLStore };
  });
  vi.doMock('../../src/mastra/tools/ping', async (importOriginal) => {
    const { pingTool } = await importOriginal<Ping>();
    const execute = pingTool.execute as unknown as Execute;
    const recorded: Execute = async (input, context) => {
      // Recorded on entry, then with its output or rejection, so a throwing tool is kept too.
      const requestContext = [...context.requestContext.entries()];
      const call: Record<string, unknown> = { input, requestContext };
      toolCalls.push(call);
      try {
        call.output = await execute(input, context);
        return call.output;
      } catch (error) {
        call.rejection = error;
        throw error;
      }
    };
    return { pingTool: Object.assign(pingTool, { execute: recorded }) };
  });
  mock = await prepareTestEnvironment('connections');
  authRoute = await import('../../src/app/api/auth/[...all]/route');
  copilotRoute = await import('../../src/app/api/copilotkit/[[...slug]]/route');
  db = await import('../../src/server/db/client');
  env = (await import('../../src/server/env')).getServerEnv();
  ({ tenantContextResolver: resolver } = await import('../../src/server/services/tenant-context'));
  connections = await import('../../src/server/services/workspace-connections');
  provisioner = await import('../../src/server/services/workspace-provisioner');
  hosts = await import('../../src/server/db/workspace-hosts');
  cipher = await import('../../src/server/db/token-cipher');
});

afterAll(async () => {
  await mock?.stop();
});

async function post(client: TestClient, path: string, body: object) {
  const response = await client.call(authRoute.POST, 'POST', `/api/auth${path}`, body);
  expect(response.status, path).toBe(200);
  return (await response.json()) as { id: string };
}

async function signIn(label: string): Promise<TestClient> {
  const client = new TestClient();
  const credentials = { email: `${label}-${stamp}@example.test`, password: 'integration-pass-123' };
  await post(client, '/sign-up/email', { ...credentials, name: label });
  await post(client, '/sign-in/email', credentials);
  return client;
}

/** Creates an organization, makes it active and returns its active registry row. */
async function createWorkspace(client: TestClient, name: string): Promise<Row> {
  const { id } = await post(client, '/organization/create', { name, slug: `${name}-${stamp}` });
  await post(client, '/organization/set-active', { organizationId: id });
  const byOrganization = eq(workspaceRegistry.organizationId, id);
  const rows = await db.controlDb.select().from(workspaceRegistry).where(byOrganization);
  expect(rows).toMatchObject([{ status: 'active' }]);
  return rows[0];
}

const setRow = (row: Row, set: Partial<Row>) =>
  db.controlDb.update(workspaceRegistry).set(set).where(eq(workspaceRegistry.id, row.id));

describe('TEN-001: a workspace connection reaches only its own database', () => {
  let owner: TestClient;
  let alpha: Row;
  let beta: Row;
  const id = `cmp_${ulid()}`;
  const find = async (workspaceId: string) => {
    const database = await connections.getWorkspaceDatabase(workspaceId);
    const byId = eq(compositions.id, id);
    return database.select({ id: compositions.id }).from(compositions).where(byId);
  };

  it('finds a composition inserted through A only through A, and B opens another database', async () => {
    owner = await signIn('owner');
    alpha = await createWorkspace(owner, 'alpha');
    beta = await createWorkspace(owner, 'beta');
    const a = await connections.getWorkspaceDatabase(alpha.id);
    const at = new Date().toISOString();
    await a.insert(compositions).values({ id, title: 'Northstar', createdAt: at, updatedAt: at });
    expect([await find(alpha.id), await find(beta.id)]).toEqual([[{ id }], []]);
    expect(await connections.getWorkspaceDatabase(alpha.id)).toBe(a);
    for (const row of [alpha, beta]) {
      const database = await connections.getWorkspaceDatabase(row.id);
      const [main] = await database.all<{ file: string }>(sql`PRAGMA database_list`);
      expect(main.file.endsWith(`${row.databaseName}.db`), row.databaseName).toBe(true);
    }
  });

  it('lets a member of both workspaces reach A only while A is active', async () => {
    const reach = async () => {
      const resolved = await resolver.resolve(owner.headers());
      if (resolved.status !== 'ok') return resolved.status;
      const { workspaceId } = resolved.context;
      return { workspaceId, found: (await find(workspaceId)).length };
    };
    const activate = (row: Row) =>
      post(owner, '/organization/set-active', { organizationId: row.organizationId });

    await activate(alpha);
    expect(await reach()).toEqual({ workspaceId: alpha.id, found: 1 });
    await setRow(alpha, { status: 'suspended' });
    expect(await reach()).toBe('workspace-unavailable');
    await activate(beta);
    expect(await reach()).toEqual({ workspaceId: beta.id, found: 0 });
    await setRow(alpha, { status: 'active' });
    await activate(alpha);
    expect(await reach()).toEqual({ workspaceId: alpha.id, found: 1 });
  });

  it('closes the cached client when the workspace is deleted, and opens none for the deleting row', async () => {
    const a = await connections.getWorkspaceDatabase(alpha.id);
    const { organizationId } = alpha;
    // On Windows a closed @libsql/client 0.18.0 file client holds its file until garbage collection
    // finalizes its statements, so this host delete may fail; the row is `deleting` either way.
    await provisioner.deleteWorkspaceDatabase(organizationId).catch(() => undefined);
    expect(a.$client.closed).toBe(true);
    const reopened = connections.getWorkspaceDatabase(alpha.id);
    await expect(reopened).rejects.toMatchObject({ code: 'WorkspaceNotActive' });

    // Deleting the organization again resumes and completes once the file is released.
    setFlagsFromString('--expose_gc');
    const collectGarbage = runInNewContext('gc') as () => void;
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const path = '/api/auth/organization/delete';
    await vi.waitFor(
      async () => {
        collectGarbage();
        const response = await owner.call(authRoute.POST, 'POST', path, { organizationId });
        expect(response.status).toBe(200);
      },
      { timeout: 10_000, interval: 250 },
    );
    logged.mockRestore();
    expect(existsSync(`${DATA_DIR}/${alpha.databaseName}.db`)).toBe(false);
  });
});

let runs = 0;
/**
 * Runs "ping" in the chat while the workspace host is Turso (stub values), recording every write to
 * stdout and stderr, whichever console method or logger makes it.
 */
async function chat(client: TestClient) {
  const writes: string[] = [];
  const record = (chunk: unknown) => writes.push(String(chunk)) > 0;
  const streams = [process.stdout, process.stderr].map((stream) =>
    vi.spyOn(stream, 'write').mockImplementation(record as never),
  );
  vi.stubGlobal('console', new Console(process.stdout, process.stderr));
  const host = env.workspaceHost;
  env.workspaceHost = TURSO_HOST;
  toolCalls.length = 0;
  runs += 1;
  try {
    console.debug('output-capture-probe');
    const id = `turso-${stamp}-${runs}`;
    const input = {
      threadId: id,
      runId: id,
      tools: [],
      context: [],
      state: {},
      forwardedProps: {},
    };
    const messages = [{ id, role: 'user', content: 'ping' }];
    const response = await client.call(copilotRoute.POST, 'POST', RUN_PATH, { ...input, messages });
    return { status: response.status, events: await readAgUiEvents(response), writes };
  } finally {
    env.workspaceHost = host;
    vi.unstubAllGlobals();
    for (const stream of streams) stream.mockRestore();
  }
}

/** JSON without repeated objects, so a value with cycles is still read. */
function json(value: unknown): string {
  const seen = new WeakSet<object>();
  const replacer = (_key: string, item: unknown) => {
    if (typeof item === 'bigint') return String(item);
    if (typeof item !== 'object' || item === null) return item;
    if (seen.has(item)) return undefined;
    seen.add(item);
    return item;
  };
  return JSON.stringify(value, replacer) ?? '';
}

const ALL = { depth: null, maxArrayLength: null, maxStringLength: null, showHidden: true };

/** Expects no secret in any value, read both by util.inspect and by JSON.stringify. */
function expectHidden(secrets: string[], values: Record<string, unknown>) {
  for (const [name, value] of Object.entries(values)) {
    const text = `${inspect(value, ALL)}\n${json(value)}`;
    for (const secret of secrets) expect(text.includes(secret), `${name}: ${secret}`).toBe(false);
  }
}

describe('TEN-008 and TEN-006: workspace credentials and Mastra storage', () => {
  let client: TestClient;
  let workspace: Row;

  /** An active workspace for `client` whose registry row holds the stub token's ciphertext. */
  async function tursoWorkspace(name: string, databaseUrl?: string): Promise<Row> {
    const row = await createWorkspace(client, name);
    const dbTokenCiphertext = cipher.createTokenCipher(TOKEN_KEY).encrypt(TOKEN, row.databaseName);
    const set = { dbTokenCiphertext, databaseUrl: databaseUrl ?? row.databaseUrl };
    await setRow(row, set);
    return { ...row, ...set };
  }
  const secretsOf = (row: Row) => [
    ...[TOKEN, String(row.dbTokenCiphertext)],
    ...[row.databaseUrl, row.databaseName],
  ];

  it('TEN-INT-008: a chat that reads the workspace shows no token, ciphertext, URL or name', async () => {
    client = await signIn('turso');
    workspace = await tursoWorkspace('turso');
    createClient.mockClear();
    const { status, events, writes } = await chat(client);
    const database = await connections.getWorkspaceDatabase(workspace.id);
    const session: unknown = Reflect.get(database, 'session');

    // Probes: output was captured, and ping opened the client with the decrypted token.
    expect([status, writes.join('')]).toEqual([200, expect.stringContaining('capture-probe')]);
    expect(toolCalls).toMatchObject([{ input: {}, output: { status: 'ok' } }]);
    expect(createClient).toHaveBeenCalledWith(expect.objectContaining({ authToken: TOKEN }));
    expect(session).toBeDefined();

    const resolved = await resolver.resolve(client.headers());
    const model = mock.getRequests();
    expectHidden(secretsOf(workspace), { events, toolCalls, writes, resolved, model });
    expectHidden(secretsOf(workspace), { database, session });
  });

  it('TEN-INT-008: a remote error echoing the token reaches the tool only as a name and code', async () => {
    // A stub libSQL server answering 500 with the request's host and Authorization header as plain
    // text, which @libsql/client copies into its error message.
    const server = createServer((request, response) => {
      response.writeHead(500, { 'content-type': 'text/plain' });
      response.end(`refused ${request.headers.host} ${request.headers.authorization}`);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;
    const remote = await tursoWorkspace('remote', `http://127.0.0.1:${port}`);
    try {
      // The probe: unsanitized, libSQL's error holds the token.
      const raw = hosts.openWorkspaceDatabase(TURSO_HOST, remote);
      const refused: unknown = await raw.execute('SELECT 1').catch((error: unknown) => error);
      raw.close();
      expect(inspect(refused, ALL)).toContain(TOKEN);

      const { status, events, writes } = await chat(client);
      const code = expect.stringMatching(/SERVER_ERROR$/);
      const rejection = { name: 'WorkspaceConnectionError', code };
      expect([status, toolCalls]).toMatchObject([200, [{ input: {}, rejection }]]);
      const secrets = [...secretsOf(remote), `127.0.0.1:${port}`];
      expectHidden(secrets, { events, toolCalls, writes, model: mock.getRequests() });
    } finally {
      await connections.closeWorkspaceDatabase(remote.id);
      server.closeAllConnections();
      server.close();
    }
  });

  it('TEN-INT-008: a registry error naming a URL and token reaches the tool only as a name and code', async () => {
    const row = await tursoWorkspace('registry');
    const controlUrl = 'libsql://melos-control-stub.example.turso.io';
    const message = `read failed at ${controlUrl}?authToken=${TOKEN}`;
    const failure = Object.assign(new Error(message), { code: 'SQLITE_IOERR' });
    const select = db.controlDb.select.bind(db.controlDb);
    // Only the connection's registry lookup selects db_token_ciphertext.
    const lookup = (fields?: Record<string, unknown>) => {
      if (fields && 'dbTokenCiphertext' in fields) throw failure;
      return select(fields as never);
    };
    const registryRead = vi.spyOn(db.controlDb, 'select').mockImplementation(lookup as never);
    try {
      const { status, events, writes } = await chat(client);
      const rejection = { name: 'WorkspaceConnectionError', code: 'Error SQLITE_IOERR' };
      expect([status, toolCalls]).toMatchObject([200, [{ input: {}, rejection }]]);
      expect(registryRead.mock.results).toContainEqual({ type: 'throw', value: failure });
      const secrets = [...secretsOf(row), controlUrl];
      expectHidden(secrets, { events, toolCalls, writes, model: mock.getRequests() });
    } finally {
      registryRead.mockRestore();
    }
  });

  it('TEN-006: Mastra storage is configured with the agent database only', async () => {
    const { id, url, authToken } = { id: 'melos-agent-storage', ...env.agentDatabase };
    expect(storageConfigs).toEqual([{ id, url, authToken }]);
    const mastraTables = async (client: Client) => {
      const query = "SELECT name FROM sqlite_master WHERE name LIKE 'mastra_%'";
      return (await client.execute(query)).rows.length;
    };
    const agent = createClient({ url });
    try {
      expect(await mastraTables(agent)).toBeGreaterThan(0);
    } finally {
      agent.close();
    }
    const database = await connections.getWorkspaceDatabase(workspace.id);
    const elsewhere = [db.controlDatabaseClient, database.$client];
    expect(await Promise.all(elsewhere.map(mastraTables))).toEqual([0, 0]);
  });
});
