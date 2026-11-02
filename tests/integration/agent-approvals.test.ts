import type { LLMock } from '@copilotkit/aimock';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TenantContext } from '../../src/server/services/tenant-context';
import { NORTHSTAR } from './catalog-support';
import { type AgUiEvent, prepareTestEnvironment, readAgUiEvents, TestClient } from './support';

// fx-rights-mutation (§5.8, TST-AI-002 draft → confirm → mutate): the route runs the Mastra agent on
// the Northstar seed, AIMock plays the model, updateWriterShares suspends for approval and a second
// run resumes it (§7.4). The approval rows and the writer set are read from the workspace database.

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
  mock = await prepareTestEnvironment('agent-approvals');
  const authRoute: { POST: Handler } = await import('../../src/app/api/auth/[...all]/route');
  copilotRoute = await import('../../src/app/api/copilotkit/[[...slug]]/route');
  tables = await import('../../src/server/db/schema/workspace.generated');
  connections = await import('../../src/server/services/workspace-connections');
  const { seedNorthstar } = await import('../../src/server/db/seed/northstar');
  const password = 'agent-approvals-test-password';
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

/** Resumes the suspended call with `decision`; returns the tool result the UI receives. */
async function resume(threadId: string, interrupt: Interrupt, decision: object) {
  const events = await run(threadId, {
    resume: [{ interruptId: interrupt.id, status: 'resolved', payload: decision }],
  });
  const result = events.find(
    (e) => e.type === 'TOOL_CALL_RESULT' && e.toolCallId === interrupt.toolCallId,
  );
  return JSON.parse(result?.content ?? 'null');
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

describe('fx-rights-mutation: updateWriterShares asks first (§5.8, §7.4, WRITE-VS-001)', () => {
  it('suspends without writing, then an approval writes 60/40 with approval.granted', async () => {
    await setShares(5000, 5000);
    const { threadId, interrupt, request } = await suspend();
    expect(request).toMatchObject({ kind: 'rights_change', toolName: 'updateWriterShares' });
    expect(await writerShares()).toEqual({ [JORDAN]: 5000, [ALEX]: 5000 });
    expect(await approvalRows(interrupt.toolCallId)).toEqual([['approval.requested', 'agent']]);

    const result = await resume(threadId, interrupt, {
      approved: true,
      inputHash: request.inputHash,
    });
    expect(result).toMatchObject({
      status: 'ok',
      value: { compositionId: OCEAN, writerTotalBp: 10000 },
    });
    expect(await writerShares()).toEqual({ [JORDAN]: 6000, [ALEX]: 4000 });
    const replaced = await (await database())
      .select()
      .from(tables.auditLog)
      .where(
        and(
          eq(tables.auditLog.action, 'writer_shares.replace'),
          eq(tables.auditLog.approvalToolCallId, interrupt.toolCallId),
        ),
      );
    expect(replaced).toHaveLength(1);
    expect(await approvalRows(interrupt.toolCallId)).toEqual([
      ['approval.requested', 'agent'],
      ['writer_shares.replace', 'agent'],
      ['approval.granted', 'agent'],
    ]);
    // Replaying the resume finds no suspended run: the tool does not run again.
    const again = await resume(threadId, interrupt, {
      approved: true,
      inputHash: request.inputHash,
    });
    expect(again).toBeNull();
    expect(await approvalRows(interrupt.toolCallId)).toHaveLength(3);
  });

  it('a decline writes nothing and audits approval.declined', async () => {
    await setShares(5000, 5000);
    const { threadId, interrupt, request } = await suspend();
    const result = await resume(threadId, interrupt, {
      approved: false,
      inputHash: request.inputHash,
    });
    expect(result).toEqual({ status: 'error', error: { code: 'DECLINED', reason: 'declined' } });
    expect(await writerShares()).toEqual({ [JORDAN]: 5000, [ALEX]: 5000 });
    expect(await approvalRows(interrupt.toolCallId)).toEqual([
      ['approval.requested', 'agent'],
      ['approval.declined', 'agent'],
    ]);
  });

  it('an answer for other input is declined as input_mismatch', async () => {
    const { threadId, interrupt } = await suspend();
    const result = await resume(threadId, interrupt, { approved: true, inputHash: 'f'.repeat(64) });
    expect(result).toEqual({
      status: 'error',
      error: { code: 'DECLINED', reason: 'input_mismatch' },
    });
    expect(await writerShares()).toEqual({ [JORDAN]: 5000, [ALEX]: 5000 });
  });

  it('writers changed between suspend and resume: STATE_CHANGED and approval.stale (AUD-003)', async () => {
    const { threadId, interrupt, request } = await suspend();
    await setShares(7000, 3000);
    const result = await resume(threadId, interrupt, {
      approved: true,
      inputHash: request.inputHash,
    });
    expect(result).toEqual({ status: 'error', error: { code: 'STATE_CHANGED' } });
    expect(await writerShares()).toEqual({ [JORDAN]: 7000, [ALEX]: 3000 });
    expect(await approvalRows(interrupt.toolCallId)).toEqual([
      ['approval.requested', 'agent'],
      ['approval.stale', 'agent'],
    ]);
  });
});
