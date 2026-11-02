import type { LLMock } from '@copilotkit/aimock';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TenantContext } from '../../src/server/services/tenant-context';
import { NORTHSTAR } from './catalog-support';
import { type AgUiEvent, prepareTestEnvironment, readAgUiEvents, TestClient } from './support';

// SA Gate E for approvals (§8 phase 7): tool error, unauthorized mutation, malformed model call and
// interrupted approval, through the route with AIMock on the Northstar seed. The fifth case, a
// stale approval, is in agent-approvals.test.ts. None of them may change the writers.

type Handler = (request: Request) => Promise<Response>;
type Interrupt = {
  id: string;
  toolCallId: string;
  metadata: { mastra: { suspendPayload: { inputHash: string; beforeHash: string } } };
};
type Event = AgUiEvent & {
  toolCallId?: string;
  outcome?: { type: string; interrupts: Interrupt[] };
};

let mock: LLMock;
let copilotRoute: { POST: Handler };
let owner: TenantContext;
let tables: typeof import('../../src/server/db/schema/workspace.generated');
let connections: typeof import('../../src/server/services/workspace-connections');
const client = new TestClient();
const { cmp_OCEAN: OCEAN, pty_JORDAN: JORDAN, pty_ALEX: ALEX } = NORTHSTAR.keys;
const ASK = 'change alex split on ocean blue to 40%';

beforeAll(async () => {
  mock = await prepareTestEnvironment('agent-approval-failures');
  const authRoute: { POST: Handler } = await import('../../src/app/api/auth/[...all]/route');
  copilotRoute = await import('../../src/app/api/copilotkit/[[...slug]]/route');
  tables = await import('../../src/server/db/schema/workspace.generated');
  connections = await import('../../src/server/services/workspace-connections');
  const { seedNorthstar } = await import('../../src/server/db/seed/northstar');
  const password = 'agent-approval-failures-password';
  const seeded = await seedNorthstar({ password, seedDate: NORTHSTAR.demo.date });
  if (seeded.status !== 'seeded') throw new Error(`Northstar was ${seeded.status}`);
  const { organizationId, workspaceId } = seeded;
  owner = {
    userId: NORTHSTAR.keys.usr_JORDAN,
    organizationId,
    workspaceId,
    workspaceRole: 'owner',
    requestId: 'test',
  };
  const email = 'jordan@silverline.example';
  await client.call(authRoute.POST, 'POST', '/api/auth/sign-in/email', { email, password });
});
afterAll(async () => {
  await mock?.stop();
});

async function run(threadId: string, extra: Record<string, unknown>): Promise<Event[]> {
  const id = crypto.randomUUID();
  const response = await client.call(copilotRoute.POST, 'POST', '/api/copilotkit/agent/melos/run', {
    ...{ threadId, runId: `run-${id}`, tools: [], context: [], state: {}, forwardedProps: {} },
    ...{ messages: [{ id: 'msg-ask', role: 'user', content: ASK }] },
    ...extra,
  });
  expect(response.status).toBe(200);
  return (await readAgUiEvents(response)) as Event[];
}

/** Asks for the DEMO-008 change in a new thread; returns the thread and the suspension. */
async function suspend() {
  const threadId = `thread-${crypto.randomUUID()}`;
  const events = await run(threadId, {});
  const finished = events.find(({ type }) => type === 'RUN_FINISHED');
  expect(finished?.outcome?.type).toBe('interrupt');
  const [interrupt] = finished?.outcome?.interrupts ?? [];
  return { threadId, interrupt, request: interrupt.metadata.mastra.suspendPayload };
}

const database = () => connections.getWorkspaceDatabase(owner.workspaceId);
const approvalRows = async (toolCallId: string) =>
  (
    await (
      await database()
    )
      .select()
      .from(tables.auditLog)
      .where(eq(tables.auditLog.approvalToolCallId, toolCallId))
      .orderBy(tables.auditLog.id)
  ).map(({ action, actorType }) => [action, actorType]);
const writerShares = async () =>
  Object.fromEntries(
    (
      await (
        await database()
      )
        .select()
        .from(tables.compositionContributors)
        .where(eq(tables.compositionContributors.compositionId, OCEAN))
    ).map(({ partyId, writerShareBp }) => [partyId, writerShareBp]),
  );
const setShares = async (jordan: number, alex: number) => {
  const { updateWriterShares } = await import('../../src/server/services/rights/shares');
  const shares = [
    { partyId: JORDAN, roles: ['songwriter' as const], shareBp: jordan },
    { partyId: ALEX, roles: ['songwriter' as const], shareBp: alex },
  ];
  expect((await updateWriterShares(owner, { compositionId: OCEAN, shares })).ok).toBe(true);
};

/** Sends `text` in a new thread; returns its events and the tool results by tool name. */
async function say(text: string) {
  const threadId = `thread-${crypto.randomUUID()}`;
  const events = await run(threadId, {
    messages: [{ id: 'msg-say', role: 'user', content: text }],
  });
  const started = events.find((e) => e.type === 'TOOL_CALL_START');
  const result = events.find(
    (e) => e.type === 'TOOL_CALL_RESULT' && e.toolCallId === started?.toolCallId,
  );
  const finished = events.find(({ type }) => type === 'RUN_FINISHED');
  return {
    events,
    threadId,
    toolCallId: started?.toolCallId ?? '',
    result: JSON.parse(result?.content ?? 'null'),
    finished,
  };
}
const approvalCount = async () =>
  (await (await database()).select().from(tables.auditLog)).filter((row) => row.approvalToolCallId)
    .length;
const UNCHANGED = () => ({ [JORDAN]: 5000, [ALEX]: 5000 });

describe('SA Gate E: approval failure cases (§8 phase 7)', () => {
  it('tool error: a song that is not in the workspace is NOT_FOUND and asks nothing', async () => {
    await setShares(5000, 5000);
    const before = await approvalCount();
    const { result, toolCallId } = await say('gate e missing song');
    expect(result).toEqual({ status: 'error', error: { code: 'NOT_FOUND' } });
    expect(await approvalRows(toolCallId)).toEqual([]);
    expect(await approvalCount()).toBe(before);
    expect(await writerShares()).toEqual(UNCHANGED());
  });

  it('unauthorized mutation: a viewer gets FORBIDDEN before any approval is requested', async () => {
    const { controlDb } = await import('../../src/server/db/client');
    const { member } = await import('../../src/server/db/schema/auth');
    const where = eq(member.organizationId, owner.organizationId);
    await controlDb.update(member).set({ role: 'viewer' }).where(where);
    try {
      const before = await approvalCount();
      const { result, finished } = await say('gate e viewer split');
      expect(result).toEqual({ status: 'error', error: { code: 'FORBIDDEN' } });
      expect(finished?.outcome).toBeUndefined();
      expect(await approvalCount()).toBe(before);
    } finally {
      await controlDb.update(member).set({ role: 'owner' }).where(where);
    }
    expect(await writerShares()).toEqual(UNCHANGED());
  });

  it('malformed model call: input the schema refuses never reaches the tool', async () => {
    // Built here, not in fixtures/aimock: TST-AI-004 requires every fixture call to be valid.
    const shares = [{ partyId: JORDAN, shareBp: 'sixty' }];
    const args = JSON.stringify({ compositionId: OCEAN, shares });
    mock.prependFixture({
      match: { userMessage: 'gate e malformed call', hasToolResult: false },
      response: { toolCalls: [{ name: 'updateWriterShares', arguments: args }] },
    });
    mock.prependFixture({
      match: { userMessage: 'gate e malformed call', hasToolResult: true },
      response: { content: 'That request was not valid, so nothing changed.' },
    });
    const before = await approvalCount();
    const { events, finished } = await say('gate e malformed call');
    expect(finished?.outcome).toBeUndefined();
    expect(events.map(({ type }) => type)).toContain('RUN_FINISHED');
    expect(await approvalCount()).toBe(before);
    expect(await writerShares()).toEqual(UNCHANGED());
  });

  it('interrupted approval: a card nobody answers leaves only approval.requested', async () => {
    const { interrupt } = await suspend();
    expect(await approvalRows(interrupt.toolCallId)).toEqual([['approval.requested', 'agent']]);
    expect(await writerShares()).toEqual(UNCHANGED());
  });
});
