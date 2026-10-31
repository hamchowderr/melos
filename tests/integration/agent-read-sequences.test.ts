import type { LLMock } from '@copilotkit/aimock';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NORTHSTAR } from './catalog-support';
import { type AgUiEvent, prepareTestEnvironment, readAgUiEvents, TestClient } from './support';

// TST-AI-001 and the read sequences of TST-AI-002 (§5.8): the route runs the Mastra agent on the
// Northstar seed, AIMock plays the model, and the tools read the real workspace database.

type Handler = (request: Request) => Promise<Response>;
type ToolCall = { name: string; args: unknown; result: unknown };

let mock: LLMock;
let copilotRoute: { POST: Handler };
const client = new TestClient();
const { cmp_MIDNIGHT: MIDNIGHT, rec_MIDNIGHT: MIDNIGHT_REC } = NORTHSTAR.keys;

beforeAll(async () => {
  mock = await prepareTestEnvironment('agent-read-sequences');
  const authRoute: { POST: Handler } = await import('../../src/app/api/auth/[...all]/route');
  copilotRoute = await import('../../src/app/api/copilotkit/[[...slug]]/route');
  const { seedNorthstar } = await import('../../src/server/db/seed/northstar');
  const password = 'read-sequences-test-password';
  const seeded = await seedNorthstar({ password, seedDate: NORTHSTAR.demo.date });
  if (seeded.status !== 'seeded') throw new Error(`Northstar was ${seeded.status}`);
  // Jordan is a member of one workspace, so the new session starts with it active (melos-2lm).
  const email = 'jordan@silverline.example';
  await client.call(authRoute.POST, 'POST', '/api/auth/sign-in/email', { email, password });
});
afterAll(async () => {
  await mock?.stop();
});

/** Sends one user message and returns the tool calls with their parsed args and UI results. */
async function ask(text: string, context: { description: string; value: string }[] = []) {
  const id = crypto.randomUUID();
  const response = await client.call(copilotRoute.POST, 'POST', '/api/copilotkit/agent/melos/run', {
    threadId: `thread-${id}`,
    runId: `run-${id}`,
    messages: [{ id: `msg-${id}`, role: 'user', content: text }],
    tools: [],
    context,
    state: {},
    forwardedProps: {},
  });
  expect(response.status).toBe(200);
  const events = (await readAgUiEvents(response)) as (AgUiEvent & {
    toolCallId?: string;
    delta?: string;
  })[];
  expect(events.map(({ type }) => type)).toContain('RUN_FINISHED');
  const calls: ToolCall[] = [];
  for (const start of events.filter(({ type }) => type === 'TOOL_CALL_START')) {
    const id = start.toolCallId;
    const args = events
      .filter((e) => e.type === 'TOOL_CALL_ARGS' && e.toolCallId === id)
      .map((e) => e.delta)
      .join('');
    const result = events.find((e) => e.type === 'TOOL_CALL_RESULT' && e.toolCallId === id);
    calls.push({
      name: String(start.toolCallName),
      args: JSON.parse(args || '{}'),
      result: JSON.parse(result?.content ?? 'null'),
    });
  }
  return calls;
}

/** The tool result text each model request carried, last message first. */
const toolResultsSentToModel = () =>
  mock
    .getRequests()
    .flatMap(
      ({ body }) => (body as { messages?: { role: string; content: unknown }[] }).messages ?? [],
    )
    .filter(({ role }) => role === 'tool')
    .map(({ content }) => (typeof content === 'string' ? content : JSON.stringify(content)));

describe('agent read sequences with AIMock (§5.8)', () => {
  it('fx-show-song: searchMusic, then getMusicWorkspace with the first result’s id', async () => {
    const calls = await ask('show me midnight drive');
    expect(calls.map(({ name, args }) => [name, args])).toEqual([
      ['searchMusic', { query: 'Midnight Drive', limit: 10 }],
      ['getMusicWorkspace', { entityType: 'composition', entityId: MIDNIGHT }],
    ]);
    const [search, workspace] = calls;
    expect(search.result).toMatchObject({ status: 'ok', value: [{ compositionId: MIDNIGHT }] });
    expect(workspace.result).toMatchObject({
      status: 'ok',
      value: { primaryRecordingId: MIDNIGHT_REC, recordings: [{ id: MIDNIGHT_REC }] },
    });
    // The UI got the full DTO; the model got only the §3.6 summary (toModelOutput).
    const sent = toolResultsSentToModel().find((text) => text.includes('pitchCountsByStatus'));
    expect(sent).toBeDefined();
    expect(sent).not.toMatch(/durationMs|licensingContacts|"releases"/);
  });

  it('fx-pronoun-context: "who wrote this" reads the focused composition’s rights', async () => {
    const focused = JSON.stringify({ focusedEntity: { type: 'composition', id: MIDNIGHT } });
    const calls = await ask('who wrote this', [
      { description: 'Melos UI context', value: focused },
    ]);
    expect(calls.map(({ name, args }) => [name, args])).toEqual([
      ['getRightsSummary', { entityType: 'composition', entityId: MIDNIGHT }],
    ]);
    expect(calls[0].result).toMatchObject({ status: 'ok', value: { compositionId: MIDNIGHT } });
  });

  it('fx-readiness: "not ready for sync" lists recordings that are not sync ready', async () => {
    const calls = await ask('not ready for sync');
    expect(calls.map(({ name, args }) => [name, args])).toEqual([
      ['getReadinessIssues', { onlyNotReady: true }],
    ]);
    const report = calls[0].result as {
      status: string;
      value: { recordings: { syncReady: boolean }[] };
    };
    expect(report.status).toBe('ok');
    expect(report.value.recordings.length).toBeGreaterThan(0);
    expect(report.value.recordings.every(({ syncReady }) => !syncReady)).toBe(true);
  });
});
