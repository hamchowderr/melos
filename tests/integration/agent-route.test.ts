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
    expect(JSON.parse(toolResult?.content ?? '{}')).toEqual({
      status: 'ok',
      organizationId: workspaceId,
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

  it('stores memory under <organizationId>:<userId>', async () => {
    const memory = await mastra.getAgent('melos').getMemory();
    expect(memory).toBeDefined();

    const scoped = await memory?.listThreads({
      filter: { resourceId: `${workspaceId}:${userId}` },
    });
    expect(scoped?.threads.length).toBeGreaterThan(0);

    const unscoped = await memory?.listThreads({ filter: { resourceId: userId } });
    expect(unscoped?.threads).toHaveLength(0);
  });
});
