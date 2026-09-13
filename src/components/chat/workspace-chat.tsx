'use client';

import {
  CopilotChat,
  CopilotChatMessageView,
  CopilotKitProvider,
  useAgent,
  useCopilotKit,
  useRenderTool,
} from '@copilotkit/react-core/v2';
import '@copilotkit/react-core/v2/styles.css';
import { useCallback, useEffect, useState } from 'react';
import { ChatRunErrorNotice } from '@/components/chat/chat-run-error';
import { PingCard } from '@/components/chat/ping-card';
import {
  PING_TOOL_NAME,
  pingInputSchema,
  pingResultSchema,
  WORKSPACE_AGENT_ID,
} from '@/lib/agent/contract';
import { type ChatRunError, isChatRunErrorCode, toChatRunError } from '@/lib/agent/run-error';

// CopilotChat throws if the agent is not registered yet; registration follows the
// provider's async /info sync, so wait for it.
function useAgentReady(agentId: string): boolean {
  const { copilotkit } = useCopilotKit();
  const [ready, setReady] = useState(() => Boolean(copilotkit.getAgent(agentId)));
  useEffect(() => {
    const check = () => setReady(Boolean(copilotkit.getAgent(agentId)));
    check();
    const subscription = copilotkit.subscribe({
      onRuntimeConnectionStatusChanged: check,
    });
    return () => subscription.unsubscribe();
  }, [copilotkit, agentId]);
  return ready;
}

// A failed run otherwise ends silently; keep one plain-language, retryable error for the turn.
function useChatRunError(agentId: string) {
  const { agent } = useAgent({ agentId });
  const { copilotkit } = useCopilotKit();
  const [runError, setRunError] = useState<ChatRunError | null>(null);

  // Every new run, a send or a retry, starts without the previous run's error.
  useEffect(() => {
    const subscription = agent.subscribe({ onRunInitialized: () => setRunError(null) });
    return () => subscription.unsubscribe();
  }, [agent]);

  // CopilotChat's onError prop is typed together with the div's DOM onError, hence `object`.
  const onError = useCallback((event: object) => {
    if (!('code' in event) || typeof event.code !== 'string' || !isChatRunErrorCode(event.code)) {
      return;
    }
    const next = toChatRunError(event.code, 'error' in event ? event.error : undefined);
    // One failure reports several codes; a generic one never replaces a specific one.
    setRunError((current) => (current && next.kind === 'unknown' ? current : next));
  }, []);

  const retry = useCallback(() => {
    const lastUserIndex = agent.messages.map((message) => message.role).lastIndexOf('user');
    if (lastUserIndex < 0) return;
    // Drop what the failed run left after the user's message, then send that message again.
    agent.setMessages(agent.messages.slice(0, lastUserIndex + 1));
    setRunError(null);
    void copilotkit.runAgent({ agent });
  }, [agent, copilotkit]);

  return { runError, onError, retry };
}

function parsePingResult(result: string) {
  try {
    const parsed = pingResultSchema.safeParse(JSON.parse(result));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function ReadyChat() {
  const { runError, onError, retry } = useChatRunError(WORKSPACE_AGENT_ID);

  return (
    <CopilotChat
      agentId={WORKSPACE_AGENT_ID}
      className="min-h-0 flex-1"
      onError={onError}
      messageView={{
        children: ({ messageElements, interruptElement, isRunning }) => (
          <div
            data-testid="copilot-message-list"
            className="copilotKitMessages cpk:flex cpk:flex-col"
          >
            {messageElements}
            {interruptElement}
            {isRunning ? (
              <div className="cpk:mt-2">
                <CopilotChatMessageView.Cursor />
              </div>
            ) : null}
            {runError && !isRunning ? (
              <ChatRunErrorNotice error={runError} onRetry={retry} />
            ) : null}
          </div>
        ),
      }}
    />
  );
}

function Chat() {
  const ready = useAgentReady(WORKSPACE_AGENT_ID);

  useRenderTool(
    {
      name: PING_TOOL_NAME,
      parameters: pingInputSchema,
      render: (props) => {
        if (props.status !== 'complete') {
          return <div className="p-4 text-sm text-muted-foreground">Pinging workspace...</div>;
        }
        const result = parsePingResult(props.result);
        return result ? (
          <PingCard result={result} />
        ) : (
          <div role="alert" className="text-sm text-destructive">
            Unexpected ping result.
          </div>
        );
      },
    },
    [],
  );

  if (!ready) {
    return <div className="p-4 text-sm text-muted-foreground">Connecting to the agent...</div>;
  }
  return <ReadyChat />;
}

export function WorkspaceChat() {
  return (
    <CopilotKitProvider runtimeUrl="/api/copilotkit" agentId={WORKSPACE_AGENT_ID}>
      <Chat />
    </CopilotKitProvider>
  );
}
