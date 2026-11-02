import { type BaseEvent, EventType } from '@ag-ui/client';

type Interrupt = {
  toolCallId?: string;
  metadata?: { mastra?: { toolName?: string; args?: unknown } };
};

/**
 * The tool call events of each suspended call the run did not stream (§7.4). @ag-ui/mastra holds a
 * non-streamed tool call until its result and drops it when the tool suspends, so without these
 * the chat has no tool call for the approval's resumed TOOL_CALL_RESULT to land on, and the
 * result's card (the RightsPanel) never renders. Emitted just before the interrupting RUN_FINISHED.
 */
export function suspendedToolCalls(finished: BaseEvent, produced: BaseEvent[]): BaseEvent[] {
  if (finished.type !== EventType.RUN_FINISHED) return [];
  const outcome = (finished as BaseEvent & { outcome?: { type?: string; interrupts?: unknown } })
    .outcome;
  if (outcome?.type !== 'interrupt' || !Array.isArray(outcome.interrupts)) return [];
  const started = new Set(
    produced
      .filter((event) => event.type === EventType.TOOL_CALL_START)
      .map((event) => (event as BaseEvent & { toolCallId: string }).toolCallId),
  );
  return (outcome.interrupts as Interrupt[]).flatMap(({ toolCallId, metadata }) => {
    const toolCallName = metadata?.mastra?.toolName;
    if (!toolCallId || !toolCallName || started.has(toolCallId)) return [];
    started.add(toolCallId);
    const delta = JSON.stringify(metadata?.mastra?.args ?? {});
    return [
      { type: EventType.TOOL_CALL_START, toolCallId, toolCallName },
      { type: EventType.TOOL_CALL_ARGS, toolCallId, delta },
      { type: EventType.TOOL_CALL_END, toolCallId },
    ] as BaseEvent[];
  });
}
