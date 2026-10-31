import type { BaseEvent } from '@ag-ui/client';
import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as one from '../../src/server/agent/melos-agent-runner';
import { migrateRuntimeDatabase, type RuntimeDatabase } from '../../src/server/db/runtime-database';
import * as runtimeSchema from '../../src/server/db/schema/runtime';
import { all, FakeAgent, input, text } from './runner-support';

// Two server instances: a second copy of the runner module has its own live-run map and id.
const SECOND_INSTANCE = '../../src/server/agent/melos-agent-runner?instance=2';
const two: typeof one = await import(/* @vite-ignore */ SECOND_INSTANCE);

const { agentThreadRuns, agentThreads } = runtimeSchema;
const client = createClient({ url: ':memory:' });
let db: RuntimeDatabase;
beforeAll(async () => {
  await migrateRuntimeDatabase(client);
  db = drizzle(client, { schema: runtimeSchema });
});
afterAll(() => client.close());

const A = { resourceId: 'ws_a:user_1', workspaceId: 'ws_a' };
const FAST = { pollMs: 20, heartbeatMs: 40, connectBudgetMs: 2_000 };
const on = (instance: typeof one, timing = FAST) =>
  new instance.MelosAgentRunner(A, async () => db, timing);
const thread = async (threadId: string) =>
  (await db.select().from(agentThreads).where(eq(agentThreads.threadId, threadId)))[0];
const runsOf = (threadId: string) =>
  db.select().from(agentThreadRuns).where(eq(agentThreadRuns.threadId, threadId));

/** Starts a run on instance one that holds until aborted, and waits until it owns the thread. */
async function holdOnOne(threadId: string, agent = new FakeAgent('held', true)) {
  const done = all(on(one).run({ threadId, agent, input: input(threadId, 'r1') }));
  await expect.poll(async () => (await thread(threadId))?.activeRunId).toBe('r1');
  return { agent, done };
}

describe('MelosAgentRunner across instances (§7.9, P-32)', () => {
  it('runs on two module copies with different instance ids', () => {
    expect(two.MelosAgentRunner).not.toBe(one.MelosAgentRunner);
  });

  it('refreshes the heartbeat while a run is live', async () => {
    const { agent, done } = await holdOnOne('t-beat');
    const first = (await thread('t-beat')).runHeartbeatAt;
    await expect.poll(async () => (await thread('t-beat')).runHeartbeatAt).not.toBe(first);
    agent.abortRun();
    await done;
  });

  it('stops a run from another instance through stop_requested_at (U-24)', async () => {
    const { done } = await holdOnOne('t-stop');
    expect(await on(two).stop({ threadId: 't-stop' })).toBe(true);
    await done;
    expect((await runsOf('t-stop')).map(({ status }) => status)).toEqual(['stopped']);
  });

  it('replays a run that finishes on another instance to a waiting connect (U-23)', async () => {
    const { agent, done } = await holdOnOne('t-tail');
    const replay = all(on(two).connect({ threadId: 't-tail' }));
    setTimeout(() => agent.abortRun(), 60);
    await done;
    expect(text(await replay)).toEqual(['held']);
  });

  it('emits melos.run_pending when the run outlasts the connect budget (P-41)', async () => {
    const { agent, done } = await holdOnOne('t-pending');
    const events = await all(
      on(two, { ...FAST, connectBudgetMs: 50 }).connect({ threadId: 't-pending' }),
    );
    expect(events.at(-1)).toMatchObject({
      type: 'CUSTOM',
      name: one.RUN_PENDING_EVENT,
      value: { threadId: 't-pending', runId: 'r1' },
    } as Partial<BaseEvent>);
    agent.abortRun();
    await done;
  });

  it('aborts and writes nothing when another request takes the thread', async () => {
    const { done } = await holdOnOne('t-lost');
    await db
      .update(agentThreads)
      .set({ activeRunId: 'r-other' })
      .where(eq(agentThreads.threadId, 't-lost'));
    await done;
    expect(await runsOf('t-lost')).toEqual([]);
  });

  it('lets a new run take a thread whose heartbeat went stale', async () => {
    const stale = new Date(Date.now() - one.RUN_STALE_MS - 1000).toISOString();
    const now = new Date().toISOString();
    await db.insert(agentThreads).values({
      threadId: 't-stale',
      ...A,
      agentId: 'melos',
      activeRunId: 'dead',
      runInstanceId: 'gone',
      runHeartbeatAt: stale,
      createdAt: now,
      updatedAt: now,
    });
    const run = on(two).run({
      threadId: 't-stale',
      agent: new FakeAgent('hi'),
      input: input('t-stale', 'r1'),
    });
    expect(text(await all(run))).toEqual(['hi']);
    expect(await thread('t-stale')).toMatchObject({ activeRunId: null, nextRunSeq: 2 });
  });
});
