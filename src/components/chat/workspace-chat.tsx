'use client';

import {
  CopilotChat,
  CopilotKitProvider,
  useCopilotKit,
  useRenderTool,
} from '@copilotkit/react-core/v2';
import '@copilotkit/react-core/v2/styles.css';
import { useEffect, useState } from 'react';
import { PingCard } from '@/components/chat/ping-card';
import {
  PING_TOOL_NAME,
  pingInputSchema,
  pingResultSchema,
  WORKSPACE_AGENT_ID,
} from '@/lib/agent/contract';

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

function parsePingResult(result: string) {
  try {
    const parsed = pingResultSchema.safeParse(JSON.parse(result));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function Chat() {
  const ready = useAgentReady(WORKSPACE_AGENT_ID);

  useRenderTool(
    {
      name: PING_TOOL_NAME,
      parameters: pingInputSchema,
      render: (props) => {
        if (props.status !== 'complete') {
          return <div className="chat-status">Pinging workspace...</div>;
        }
        const result = parsePingResult(props.result);
        return result ? (
          <PingCard result={result} />
        ) : (
          <div role="alert" className="form-error">
            Unexpected ping result.
          </div>
        );
      },
    },
    [],
  );

  if (!ready) return <div className="chat-status">Connecting to the agent...</div>;
  return <CopilotChat agentId={WORKSPACE_AGENT_ID} className="melos-chat" />;
}

export function WorkspaceChat() {
  return (
    <CopilotKitProvider runtimeUrl="/api/copilotkit" agentId={WORKSPACE_AGENT_ID}>
      <Chat />
    </CopilotKitProvider>
  );
}
