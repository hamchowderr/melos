import { type BaseEvent, compactEvents, EventType } from '@ag-ui/client';
import {
  AgentRunner,
  type AgentRunnerConnectRequest,
  type AgentRunnerIsRunningRequest,
  type AgentRunnerRunRequest,
  type AgentRunnerStopRequest,
  finalizeRunEvents,
} from '@copilotkit/runtime/v2';
import { and, asc, eq, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { type Observable, ReplaySubject } from 'rxjs';
import { getRuntimeDatabase, type RuntimeDatabase } from '../db/runtime-database';
import { type AgentRunStatus, agentThreadRuns, agentThreads } from '../db/schema/runtime';
import { runtimeIntegrityGuard } from '../services/integrity-guard';

/** A heartbeat older than this marks a run dead, so another request may take the thread (P-32). */
export const RUN_STALE_MS = 30_000;

/** This server instance, recorded on the runs it takes (`run_instance_id`, §7.9). */
const INSTANCE_ID = crypto.randomUUID();

/** A run active on this instance, keyed by `resourceId|threadId` (§7.9 live tail). */
type LiveRun = {
  runId: string;
  events: ReplaySubject<BaseEvent>;
  abort: () => void;
  stopRequested: boolean;
};
const liveRuns = new Map<string, LiveRun>();

export type RunnerTenant = { resourceId: string; workspaceId: string };

/** The in-memory runner's message for a busy thread (§7.9). */
const alreadyRunning = () => new Error('Thread already running');
/** A thread id another resource owns. The message names nothing about that owner (TEN-009). */
const notOwned = () => new Error('Thread not found');

const iso = (ms = Date.now()) => new Date(ms).toISOString();
const messageIdOf = (event: BaseEvent) =>
  'messageId' in event && typeof event.messageId === 'string' ? event.messageId : undefined;

/** Whose run it is from the events it produced: stop, error, interrupt outcome or a finish. */
function runStatus(events: BaseEvent[], stopped: boolean, failed: boolean): AgentRunStatus {
  if (stopped) return 'stopped';
  if (failed) return 'error';
  const finished = events.findLast((event) => event.type === EventType.RUN_FINISHED) as
    | (BaseEvent & { outcome?: { type?: string } })
    | undefined;
  if (finished?.outcome?.type === 'interrupt') return 'interrupted';
  return events.some((event) => event.type === EventType.RUN_ERROR) ? 'error' : 'finished';
}

/**
 * The CopilotKit runner (§7.9, ADR-023), built per request for one tenant. Every read and write
 * filters on thread id and `<workspaceId>:<userId>` resource (TEN-009); finished runs persist in
 * melos-agent-runtime for any instance to replay (TEN-010). No local thread endpoints.
 */
export class MelosAgentRunner extends AgentRunner {
  constructor(
    private readonly tenant: RunnerTenant,
    private readonly database: () => Promise<RuntimeDatabase> = getRuntimeDatabase,
  ) {
    super();
  }

  private key(threadId: string) {
    return `${this.tenant.resourceId}|${threadId}`;
  }

  private owned(threadId: string) {
    return and(
      eq(agentThreads.threadId, threadId),
      eq(agentThreads.resourceId, this.tenant.resourceId),
    );
  }

  /** Inserts the thread for this resource when absent and takes it by compare-and-set (§7.9). */
  private async claim(db: RuntimeDatabase, threadId: string, runId: string, agentId: string) {
    const now = Date.now();
    await db.transaction(async (tx) => {
      const [row] = await tx
        .select({ resourceId: agentThreads.resourceId })
        .from(agentThreads)
        .where(eq(agentThreads.threadId, threadId));
      if (row && row.resourceId !== this.tenant.resourceId) throw notOwned();
      if (!row) {
        const { resourceId, workspaceId } = this.tenant;
        const stamps = { createdAt: iso(now), updatedAt: iso(now) };
        await runtimeIntegrityGuard.insert(tx, agentThreads, [
          { threadId, resourceId, workspaceId, agentId, ...stamps },
        ]);
      }
      const taken = await tx
        .update(agentThreads)
        .set({
          activeRunId: runId,
          runInstanceId: INSTANCE_ID,
          runHeartbeatAt: iso(now),
          stopRequestedAt: null,
          updatedAt: iso(now),
        })
        .where(
          and(
            this.owned(threadId),
            or(
              isNull(agentThreads.activeRunId),
              lt(agentThreads.runHeartbeatAt, iso(now - RUN_STALE_MS)),
            ),
          ),
        );
      if (taken.rowsAffected === 0) throw alreadyRunning();
    });
  }

  /**
   * Stores the run's compacted events with the thread's next seq and releases the thread, in one
   * transaction conditioned on still holding it. A run that lost the thread writes nothing.
   */
  private async finish(
    db: RuntimeDatabase,
    threadId: string,
    runId: string,
    parentRunId: string | null,
    status: AgentRunStatus,
    events: BaseEvent[],
  ) {
    await db.transaction(async (tx) => {
      const [row] = await tx
        .update(agentThreads)
        .set({
          activeRunId: null,
          runInstanceId: null,
          runHeartbeatAt: null,
          stopRequestedAt: null,
          nextRunSeq: sql`${agentThreads.nextRunSeq} + 1`,
          updatedAt: iso(),
        })
        .where(and(this.owned(threadId), eq(agentThreads.activeRunId, runId)))
        .returning({ next: agentThreads.nextRunSeq });
      if (!row) return;
      const eventsJson = JSON.stringify(compactEvents(events));
      await runtimeIntegrityGuard.insert(tx, agentThreadRuns, [
        { threadId, runId, seq: row.next - 1, parentRunId, status, eventsJson, createdAt: iso() },
      ]);
    });
  }

  private async history(db: RuntimeDatabase, threadId: string) {
    return db
      .select({ runId: agentThreadRuns.runId, eventsJson: agentThreadRuns.eventsJson })
      .from(agentThreadRuns)
      .innerJoin(agentThreads, eq(agentThreads.threadId, agentThreadRuns.threadId))
      .where(this.owned(threadId))
      .orderBy(asc(agentThreadRuns.seq));
  }

  run({ threadId, agent, input }: AgentRunnerRunRequest): Observable<BaseEvent> {
    const events = new ReplaySubject<BaseEvent>(Infinity);
    const key = this.key(threadId);
    const runId = input.runId;
    const live: LiveRun = { runId, events, abort: () => agent.abortRun(), stopRequested: false };
    const produced: BaseEvent[] = [];
    const emit = (event: BaseEvent) => {
      produced.push(event);
      events.next(event);
    };

    const execute = async () => {
      const db = await this.database();
      // Ownership and the take happen before the agent starts (§7.9).
      await this.claim(db, threadId, runId, agent.agentId ?? 'default');
      const runs = await this.history(db, threadId);
      const parentRunId = runs.at(-1)?.runId ?? null;
      liveRuns.set(key, live);
      let failure: string | undefined;
      try {
        await agent.runAgent(input, { onEvent: ({ event }) => emit(event) });
      } catch (error) {
        // As the in-memory runner does: the chat classifies the provider's text (run-error.ts).
        failure = error instanceof Error ? error.message : String(error);
      }
      const options = { stopRequested: live.stopRequested };
      const tail = finalizeRunEvents(
        produced,
        failure !== undefined ? { ...options, interruptionMessage: failure } : options,
      );
      for (const event of tail) emit(event);
      const status = runStatus(produced, live.stopRequested, failure !== undefined);
      try {
        await this.finish(db, threadId, runId, parentRunId, status, produced);
      } finally {
        if (liveRuns.get(key) === live) liveRuns.delete(key);
      }
    };

    execute().then(
      () => events.complete(),
      (error: unknown) => events.error(error),
    );
    return events.asObservable();
  }

  connect({ threadId }: AgentRunnerConnectRequest): Observable<BaseEvent> {
    const out = new ReplaySubject<BaseEvent>(Infinity);
    const replay = async () => {
      const db = await this.database();
      const runs = await this.history(db, threadId);
      const stored = runs.flatMap(({ eventsJson }) => JSON.parse(eventsJson) as BaseEvent[]);
      const emitted = new Set<string>();
      for (const event of compactEvents(stored)) {
        const messageId = messageIdOf(event);
        if (messageId) emitted.add(messageId);
        out.next(event);
      }
      const live = liveRuns.get(this.key(threadId));
      if (!live) return out.complete();
      live.events.subscribe({
        next: (event) => {
          const messageId = messageIdOf(event);
          if (messageId && emitted.has(messageId)) return;
          out.next(event);
        },
        complete: () => out.complete(),
        error: () => out.complete(),
      });
    };
    replay().catch((error: unknown) => out.error(error));
    return out.asObservable();
  }

  async isRunning({ threadId }: AgentRunnerIsRunningRequest): Promise<boolean> {
    const db = await this.database();
    const [row] = await db
      .select({ heartbeat: agentThreads.runHeartbeatAt })
      .from(agentThreads)
      .where(and(this.owned(threadId), isNotNull(agentThreads.activeRunId)));
    return row?.heartbeat != null && row.heartbeat >= iso(Date.now() - RUN_STALE_MS);
  }

  async stop({ threadId, runId }: AgentRunnerStopRequest): Promise<boolean> {
    const db = await this.database();
    const [row] = await db
      .select({ activeRunId: agentThreads.activeRunId })
      .from(agentThreads)
      .where(this.owned(threadId));
    if (!row?.activeRunId || (runId !== undefined && runId !== row.activeRunId)) return false;
    const live = liveRuns.get(this.key(threadId));
    if (!live || live.runId !== row.activeRunId || live.stopRequested) return false;
    live.stopRequested = true;
    live.abort();
    return true;
  }
}
