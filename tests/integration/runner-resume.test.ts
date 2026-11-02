import { AbstractAgent, type BaseEvent, EventType, type RunAgentInput } from '@ag-ui/client';
import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { Observable } from 'rxjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MelosAgentRunner } from '../../src/server/agent/melos-agent-runner';
import { migrateRuntimeDatabase, type RuntimeDatabase } from '../../src/server/db/runtime-database';
import * as runtimeSchema from '../../src/server/db/schema/runtime';
import { all, FakeAgent, input, text } from './runner-support';

// An approval through the runner (§7.4, §7.9): the suspended tool call reaches the chat, and the
// chat's resume, which reuses the interrupted run's id, is stored on that run's row.

const { agentThreadRuns } = runtimeSchema;
const client = createClient({ url: ':memory:' });
let db: RuntimeDatabase;
beforeAll(async () => {
  await migrateRuntimeDatabase(client);
  db = drizzle(client, { schema: runtimeSchema });
});
afterAll(() => client.close());

const A = { resourceId: 'ws_a:user_1', workspaceId: 'ws_a' };
const runner = () => new MelosAgentRunner(A, async () => db);
const ARGS = { compositionId: 'cmp_1', shares: [] };

/** Ends its run suspended on `call_1`, as @ag-ui/mastra does: no tool call events of its own. */
class SuspendingAgent extends AbstractAgent {
  constructor() {
    super({ agentId: 'melos' });
  }
  run({ threadId, runId }: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      subscriber.next({ type: EventType.RUN_STARTED, threadId, runId } as BaseEvent);
      const metadata = { mastra: { toolName: 'updateWriterShares', args: ARGS } };
      const interrupts = [{ id: `${runId}::call_1`, toolCallId: 'call_1', metadata }];
      const outcome = { type: 'interrupt', interrupts };
      subscriber.next({ type: EventType.RUN_FINISHED, threadId, runId, outcome } as BaseEvent);
      subscriber.complete();
    });
  }
}

const toolEvents = (events: BaseEvent[]) =>
  events
    .filter(({ type }) => type.startsWith('TOOL_CALL') || type === EventType.RUN_FINISHED)
    .map(({ type }) => type);

describe('MelosAgentRunner approvals (§7.4, §7.9)', () => {
  it('emits the suspended tool call before the interrupt, once', async () => {
    const events = await all(
      runner().run({
        threadId: 't-int',
        agent: new SuspendingAgent(),
        input: input('t-int', 'r1'),
      }),
    );
    expect(toolEvents(events)).toEqual([
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.RUN_FINISHED,
    ]);
    expect(events.find(({ type }) => type === EventType.TOOL_CALL_START)).toMatchObject({
      toolCallId: 'call_1',
      toolCallName: 'updateWriterShares',
    });
    expect(events.find(({ type }) => type === EventType.TOOL_CALL_ARGS)).toMatchObject({
      delta: JSON.stringify(ARGS),
    });
  });

  it('a resume under the interrupted run id extends its row and replays both', async () => {
    await all(
      runner().run({
        threadId: 't-res',
        agent: new SuspendingAgent(),
        input: input('t-res', 'r1'),
      }),
    );
    const resumed = runner().run({
      threadId: 't-res',
      agent: new FakeAgent('done'),
      input: input('t-res', 'r1'),
    });
    expect(text(await all(resumed))).toEqual(['done']);
    const runs = await db
      .select()
      .from(agentThreadRuns)
      .where(eq(agentThreadRuns.threadId, 't-res'));
    expect(runs.map(({ runId, seq, status }) => [runId, seq, status])).toEqual([
      ['r1', 2, 'finished'],
    ]);
    const replay = await all(runner().connect({ threadId: 't-res' }));
    expect(replay.some(({ type }) => type === EventType.TOOL_CALL_START)).toBe(true);
    expect(text(replay)).toContain('done');
  });
});
