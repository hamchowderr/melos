import { AbstractAgent, type BaseEvent, EventType, type RunAgentInput } from '@ag-ui/client';
import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { firstValueFrom, Observable, toArray } from 'rxjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MelosAgentRunner } from '../../src/server/agent/melos-agent-runner';
import { migrateRuntimeDatabase, type RuntimeDatabase } from '../../src/server/db/runtime-database';
import * as runtimeSchema from '../../src/server/db/schema/runtime';

const { agentThreadRuns, agentThreads } = runtimeSchema;
const client = createClient({ url: ':memory:' });
let db: RuntimeDatabase;

beforeAll(async () => {
  await migrateRuntimeDatabase(client);
  db = drizzle(client, { schema: runtimeSchema });
});
afterAll(() => client.close());

/** An agent that says `text`, or waits until aborted when `hold` is set. */
class FakeAgent extends AbstractAgent {
  private release?: () => void;
  constructor(
    private readonly text: string,
    private readonly hold = false,
  ) {
    super({ agentId: 'melos' });
  }
  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      const { threadId, runId } = input;
      subscriber.next({ type: EventType.RUN_STARTED, threadId, runId } as BaseEvent);
      const messageId = `msg-${runId}`;
      subscriber.next({
        type: EventType.TEXT_MESSAGE_START,
        messageId,
        role: 'assistant',
      } as BaseEvent);
      subscriber.next({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId,
        delta: this.text,
      } as BaseEvent);
      subscriber.next({ type: EventType.TEXT_MESSAGE_END, messageId } as BaseEvent);
      const end = () => {
        subscriber.next({ type: EventType.RUN_FINISHED, threadId, runId } as BaseEvent);
        subscriber.complete();
      };
      if (this.hold) this.release = end;
      else end();
    });
  }
  override abortRun() {
    this.release?.();
  }
}

const A = { resourceId: 'ws_a:user_1', workspaceId: 'ws_a' };
const B = { resourceId: 'ws_b:user_1', workspaceId: 'ws_b' };
const A2 = { resourceId: 'ws_a:user_2', workspaceId: 'ws_a' };
const runner = (tenant: typeof A) => new MelosAgentRunner(tenant, async () => db);
const input = (threadId: string, runId: string) =>
  ({
    threadId,
    runId,
    messages: [],
    tools: [],
    context: [],
    state: {},
    forwardedProps: {},
  }) as RunAgentInput;
const start = (tenant: typeof A, threadId: string, runId: string, agent = new FakeAgent('hi')) =>
  runner(tenant).run({ threadId, agent, input: input(threadId, runId) });
const all = (events: Observable<BaseEvent>) => firstValueFrom(events.pipe(toArray()));
const text = (events: BaseEvent[]) =>
  events.flatMap((event) =>
    'delta' in event && typeof event.delta === 'string' ? [event.delta] : [],
  );
const thread = async (threadId: string) =>
  (await db.select().from(agentThreads).where(eq(agentThreads.threadId, threadId)))[0];

describe('TEN-INT-010: finished runs persist and replay from any runner instance', () => {
  it('stores each run with the next seq and replays them in order', async () => {
    await all(start(A, 't-hist', 'r1', new FakeAgent('one')));
    await all(start(A, 't-hist', 'r2', new FakeAgent('two')));
    const runs = await db
      .select()
      .from(agentThreadRuns)
      .where(eq(agentThreadRuns.threadId, 't-hist'));
    expect(
      runs.map(({ runId, seq, status, parentRunId }) => [runId, seq, status, parentRunId]),
    ).toEqual([
      ['r1', 1, 'finished', null],
      ['r2', 2, 'finished', 'r1'],
    ]);
    expect(await thread('t-hist')).toMatchObject({ activeRunId: null, nextRunSeq: 3 });
    // A fresh runner holds no in-process state: the replay comes from melos-agent-runtime.
    expect(text(await all(runner(A).connect({ threadId: 't-hist' })))).toEqual(['one', 'two']);
  });
});

describe('TEN-INT-009: a thread belongs to one <workspaceId>:<userId> resource', () => {
  it('refuses a run, replays nothing and stops nothing for another workspace or user', async () => {
    await all(start(A, 't-own', 'r1'));
    for (const other of [B, A2]) {
      await expect(all(start(other, 't-own', `r-${other.resourceId}`))).rejects.toThrow(
        'Thread not found',
      );
      expect(await all(runner(other).connect({ threadId: 't-own' }))).toEqual([]);
      expect(await runner(other).stop({ threadId: 't-own' })).toBe(false);
      expect(await runner(other).isRunning({ threadId: 't-own' })).toBe(false);
    }
    expect(await thread('t-own')).toMatchObject({ resourceId: A.resourceId, nextRunSeq: 2 });
  });
});

describe('MelosAgentRunner run state (§7.9, P-32)', () => {
  it('refuses a second run while one is live, and stops it on the owning instance', async () => {
    const held = new FakeAgent('held', true);
    const first = all(start(A, 't-live', 'r1', held));
    await expect.poll(() => runner(A).isRunning({ threadId: 't-live' })).toBe(true);
    await expect(all(start(A, 't-live', 'r2'))).rejects.toThrow('Thread already running');
    expect(await runner(A).stop({ threadId: 't-live', runId: 'other' })).toBe(false);
    expect(await runner(A).stop({ threadId: 't-live' })).toBe(true);
    await first;
    const [run] = await db
      .select()
      .from(agentThreadRuns)
      .where(eq(agentThreadRuns.threadId, 't-live'));
    expect(run).toMatchObject({ runId: 'r1', status: 'stopped' });
    expect(await runner(A).isRunning({ threadId: 't-live' })).toBe(false);
  });
});
