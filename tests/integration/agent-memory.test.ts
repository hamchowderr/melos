import type { LLMock } from '@copilotkit/aimock';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prepareTestEnvironment, readAgUiEvents, TestClient } from './support';

type Handler = (request: Request) => Promise<Response>;

let mock: LLMock;
let authRoute: { GET: Handler; POST: Handler };
let copilotRoute: { GET: Handler; POST: Handler };
let mastra: typeof import('../../src/mastra').mastra;
let runtime: typeof import('../../src/server/db/runtime-database');

beforeAll(async () => {
  mock = await prepareTestEnvironment('agent-memory');
  authRoute = await import('../../src/app/api/auth/[...all]/route');
  copilotRoute = await import('../../src/app/api/copilotkit/[[...slug]]/route');
  ({ mastra } = await import('../../src/mastra'));
  runtime = await import('../../src/server/db/runtime-database');
});
afterAll(async () => {
  await mock?.stop();
});

const stamp = Date.now();
const client = new TestClient();
const memory = async () => {
  const found = await mastra.getAgent('melos').getMemory();
  if (!found) throw new Error('The agent has no memory');
  return found;
};
const count = async (query: string, pattern: string) => {
  const db = await runtime.getRuntimeDatabase();
  const [row] = await db.all<{ n: number }>(sql.raw(query.replace('?', `'${pattern}'`)));
  return Number(row.n);
};

/** Creates a workspace, makes it active and pings in it; returns its organization and ws ids. */
async function workspaceWithThread(name: string) {
  const created = await client.call(authRoute.POST, 'POST', '/api/auth/organization/create', {
    name,
    slug: `${name.toLowerCase()}-${stamp}`,
  });
  const organizationId = ((await created.json()) as { id: string }).id;
  await client.call(authRoute.POST, 'POST', '/api/auth/organization/set-active', {
    organizationId,
  });
  const threadId = `thread-${name}-${stamp}`;
  const response = await client.call(copilotRoute.POST, 'POST', '/api/copilotkit/agent/melos/run', {
    threadId,
    runId: `run-${name}-${stamp}`,
    messages: [{ id: `msg-${name}`, role: 'user', content: 'ping' }],
    tools: [],
    context: [],
    state: {},
    forwardedProps: {},
  });
  const result = (await readAgUiEvents(response)).find((e) => e.type === 'TOOL_CALL_RESULT');
  const { workspaceId } = JSON.parse(result?.content ?? '{}') as { workspaceId: string };
  return { organizationId, workspaceId, threadId };
}

describe('agent memory scoping (§7.3)', () => {
  let userId = '';
  let a: Awaited<ReturnType<typeof workspaceWithThread>>;
  let b: Awaited<ReturnType<typeof workspaceWithThread>>;

  it('keeps one workspace’s threads and working memory out of another’s (TEN-INT-007)', async () => {
    const email = `memory-${stamp}@example.test`;
    const password = 'integration-password-123';
    const signUp = await client.call(authRoute.POST, 'POST', '/api/auth/sign-up/email', {
      email,
      password,
      name: 'Memory Test',
    });
    userId = ((await signUp.json()) as { user: { id: string } }).user.id;
    await client.call(authRoute.POST, 'POST', '/api/auth/sign-in/email', { email, password });
    a = await workspaceWithThread('Alpha');
    b = await workspaceWithThread('Beta');

    const resource = (ws: string) => `${ws}:${userId}`;
    const store = await memory();
    await store.updateWorkingMemory({
      resourceId: resource(a.workspaceId),
      threadId: a.threadId,
      workingMemory: JSON.stringify({ tone: 'brief' }),
    });
    const inB = await store.getWorkingMemory({
      resourceId: resource(b.workspaceId),
      threadId: b.threadId,
    });
    expect(inB ?? '').not.toContain('brief');
    // U-22: Mastra itself refuses a thread that another resource owns, on the embedded path too.
    const crossed = mastra.getAgent('melos').generate('ping', {
      memory: { thread: a.threadId, resource: resource(b.workspaceId) },
    });
    await expect(crossed).rejects.toThrow(/resource/i);
    const listed = await store.listThreads({ filter: { resourceId: resource(b.workspaceId) } });
    expect(listed.threads.map(({ id }) => id)).toEqual([b.threadId]);
  });

  it('deletes only the deleted workspace’s Mastra threads, working memory and runner rows', async () => {
    const threads = 'SELECT count(*) AS n FROM mastra_threads WHERE resourceId LIKE ?';
    const messages = 'SELECT count(*) AS n FROM mastra_messages WHERE thread_id = ?';
    const runner = 'SELECT count(*) AS n FROM agent_threads WHERE resource_id LIKE ?';
    const runs = 'SELECT count(*) AS n FROM agent_thread_runs WHERE thread_id = ?';
    const resources = 'SELECT count(*) AS n FROM mastra_resources WHERE id LIKE ?';
    const left = async ({ workspaceId, threadId }: typeof a) => [
      await count(threads, `${workspaceId}:%`),
      (await count(messages, threadId)) > 0,
      await count(runner, `${workspaceId}:%`),
      await count(runs, threadId),
    ];
    expect(await left(a)).toEqual([1, true, 1, 1]);
    expect(await count(resources, `${a.workspaceId}:%`)).toBe(1);

    const deleted = await client.call(authRoute.POST, 'POST', '/api/auth/organization/delete', {
      organizationId: a.organizationId,
    });
    expect(deleted.status).toBe(200);
    expect(await left(a)).toEqual([0, false, 0, 0]);
    expect(await count(resources, `${a.workspaceId}:%`)).toBe(0);
    expect(await left(b)).toEqual([1, true, 1, 1]);
  });
});
