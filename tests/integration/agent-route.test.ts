import type { LLMock } from '@copilotkit/aimock';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toChatRunError } from '../../src/lib/agent/run-error';
import { prepareTestEnvironment, readAgUiEvents, TestClient } from './support';

type Handler = (request: Request) => Promise<Response>;

let mock: LLMock;
let authRoute: { GET: Handler; POST: Handler };
let copilotRoute: { GET: Handler; POST: Handler };
let mastra: typeof import('../../src/mastra').mastra;

beforeAll(async () => {
  mock = await prepareTestEnvironment('agent');
  authRoute = await import('../../src/app/api/auth/[...all]/route');
  copilotRoute = await import('../../src/app/api/copilotkit/[[...slug]]/route');
  ({ mastra } = await import('../../src/mastra'));
});

afterAll(async () => {
  await mock?.stop();
});

describe('agent route: session -> tenant context -> Mastra tool (AIMock model)', () => {
  const stamp = Date.now();
  const client = new TestClient();
  let userId = '';
  let workspaceId = '';
  let workspaceDbId = '';

  it('rejects callers without a session', async () => {
    const response = await new TestClient().call(copilotRoute.GET, 'GET', '/api/copilotkit/info');
    expect(response.status).toBe(401);
  });

  it('rejects a signed-in caller with no active workspace', async () => {
    const email = `agent-${stamp}@example.test`;
    const password = 'integration-password-123';
    const signUp = await client.call(authRoute.POST, 'POST', '/api/auth/sign-up/email', {
      email,
      password,
      name: 'Agent Test',
    });
    userId = ((await signUp.json()) as { user: { id: string } }).user.id;
    await client.call(authRoute.POST, 'POST', '/api/auth/sign-in/email', { email, password });

    const response = await client.call(copilotRoute.GET, 'GET', '/api/copilotkit/info');
    expect(response.status).toBe(403);
  });

  it('runs the agent; the ping tool reads the workspace from the session', async () => {
    const created = await client.call(authRoute.POST, 'POST', '/api/auth/organization/create', {
      name: 'Agent Records',
      slug: `agent-records-${stamp}`,
    });
    workspaceId = ((await created.json()) as { id: string }).id;
    await client.call(authRoute.POST, 'POST', '/api/auth/organization/set-active', {
      organizationId: workspaceId,
    });

    const response = await client.call(
      copilotRoute.POST,
      'POST',
      '/api/copilotkit/agent/melos/run',
      {
        threadId: `thread-${stamp}`,
        runId: `run-${stamp}`,
        messages: [{ id: 'msg-1', role: 'user', content: 'ping' }],
        tools: [],
        context: [],
        state: {},
        forwardedProps: {},
      },
    );
    expect(response.status).toBe(200);

    const events = await readAgUiEvents(response);
    const types = events.map((event) => event.type);
    expect(events.find((event) => event.type === 'TOOL_CALL_START')?.toolCallName).toBe('ping');

    const toolResult = events.find((event) => event.type === 'TOOL_CALL_RESULT');
    const ping = JSON.parse(toolResult?.content ?? '{}') as { workspaceId: string };
    workspaceDbId = ping.workspaceId;
    expect(ping).toEqual({
      status: 'ok',
      organizationId: workspaceId,
      workspaceId: expect.stringMatching(/^ws_[0-9A-HJKMNP-TV-Z]{26}$/),
      userId,
      workspaceRole: 'owner',
    });
    expect(types).toContain('RUN_FINISHED');
    // Both model turns (tool call, then the reply) were served by AIMock.
    expect(mock.getRequests().length).toBeGreaterThanOrEqual(2);
  });

  it('ends the run with RUN_ERROR when the model provider rejects it', async () => {
    const response = await client.call(
      copilotRoute.POST,
      'POST',
      '/api/copilotkit/agent/melos/run',
      {
        threadId: `thread-error-${stamp}`,
        runId: `run-error-${stamp}`,
        messages: [
          { id: 'msg-error-1', role: 'user', content: 'simulate a provider credits error' },
        ],
        tools: [],
        context: [],
        state: {},
        forwardedProps: {},
      },
    );
    expect(response.status).toBe(200);

    const runError = (await readAgUiEvents(response)).find((event) => event.type === 'RUN_ERROR');
    expect(runError).toBeDefined();
    // The chat classifies the provider's text but never renders it.
    expect(toChatRunError('agent_run_error_event', { message: runError?.message }).kind).toBe(
      'credits',
    );
  });

  it('stores memory under <workspaceId>:<userId> (TEN-007)', async () => {
    const memory = await mastra.getAgent('melos').getMemory();
    expect(memory).toBeDefined();

    const scoped = await memory?.listThreads({
      filter: { resourceId: `${workspaceDbId}:${userId}` },
    });
    expect(scoped?.threads.length).toBeGreaterThan(0);

    for (const resourceId of [userId, `${workspaceId}:${userId}`]) {
      const other = await memory?.listThreads({ filter: { resourceId } });
      expect(other?.threads).toHaveLength(0);
    }
  });

  it('answers 404 for agent/suggest and runs nothing (TEN-012)', async () => {
    const threadId = `thread-suggest-${stamp}`;
    const before = mock.getRequests().length;
    const response = await client.call(
      copilotRoute.POST,
      'POST',
      '/api/copilotkit/agent/melos/suggest',
      {
        threadId,
        runId: `run-suggest-${stamp}`,
        messages: [{ id: 'msg-s', role: 'user', content: 'ping' }],
        tools: [],
        context: [],
        state: {},
        forwardedProps: {},
      },
    );
    expect(response.status).toBe(404);
    expect(mock.getRequests().length).toBe(before);
    const memory = await mastra.getAgent('melos').getMemory();
    expect(await memory?.getThreadById({ threadId })).toBeNull();
  });

  it('answers 404 for thread, memory and inspector routes (TEN-012)', async () => {
    const paths: [string, string][] = [
      ['GET', '/api/copilotkit/threads'],
      ['GET', `/api/copilotkit/threads/thread-${stamp}/messages`],
      ['GET', `/api/copilotkit/threads/thread-${stamp}/events`],
      ['POST', '/api/copilotkit/threads/clear'],
      ['GET', '/api/copilotkit/memories'],
      ['GET', '/api/copilotkit/inspector-metadata'],
      ['POST', '/api/copilotkit/transcribe'],
      ['GET', '/api/copilotkit/cpk-debug-events'],
    ];
    for (const [method, path] of paths) {
      const handler = method === 'GET' ? copilotRoute.GET : copilotRoute.POST;
      const response = await client.call(handler, method, path, method === 'POST' ? {} : undefined);
      expect([path, response.status]).toEqual([path, 404]);
    }
  });
});
