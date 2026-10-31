import { AbstractAgent, type BaseEvent, EventType, type RunAgentInput } from '@ag-ui/client';
import { firstValueFrom, Observable, toArray } from 'rxjs';

// Shared by the MelosAgentRunner tests: a scripted AG-UI agent and stream helpers.

/** An agent that says `text`, or waits until aborted when `hold` is set. */
export class FakeAgent extends AbstractAgent {
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

export const input = (threadId: string, runId: string) =>
  ({
    threadId,
    runId,
    messages: [],
    tools: [],
    context: [],
    state: {},
    forwardedProps: {},
  }) as RunAgentInput;
export const all = (events: Observable<BaseEvent>) => firstValueFrom(events.pipe(toArray()));
export const text = (events: BaseEvent[]) =>
  events.flatMap((event) =>
    'delta' in event && typeof event.delta === 'string' ? [event.delta] : [],
  );
