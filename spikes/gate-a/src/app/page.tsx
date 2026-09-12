"use client";

import {
  CopilotChat,
  CopilotKitProvider,
  useCopilotKit,
  useRenderTool,
} from "@copilotkit/react-core/v2";
import "@copilotkit/react-core/v2/styles.css";
import { useEffect, useState } from "react";
import { CompositionCard } from "@/components/composition-card";
import {
  compositionSchema,
  getCompositionInputSchema,
} from "@/lib/composition";

const AGENT_ID = "catalog";

// CopilotChat throws if the agent is not registered yet (registration follows
// the provider's async /info sync), so wait for it.
function useAgentReady(agentId: string): boolean {
  const { copilotkit } = useCopilotKit();
  const [ready, setReady] = useState(() => Boolean(copilotkit.getAgent(agentId)));
  useEffect(() => {
    const check = () => setReady(Boolean(copilotkit.getAgent(agentId)));
    check();
    const sub = copilotkit.subscribe({ onRuntimeConnectionStatusChanged: check });
    return () => sub.unsubscribe();
  }, [copilotkit, agentId]);
  return ready;
}

function parseComposition(result: string) {
  try {
    const parsed = compositionSchema.safeParse(JSON.parse(result));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function CatalogChat() {
  const ready = useAgentReady(AGENT_ID);

  useRenderTool(
    {
      name: "getComposition",
      parameters: getCompositionInputSchema,
      render: (props) => {
        if (props.status !== "complete") {
          return <div data-testid="composition-loading">Looking up composition...</div>;
        }
        const composition = parseComposition(props.result);
        return composition ? (
          <CompositionCard composition={composition} />
        ) : (
          <div data-testid="composition-error">Unexpected getComposition result</div>
        );
      },
    },
    [],
  );

  if (!ready) return <div data-testid="agent-loading">Connecting to agent...</div>;
  return <CopilotChat agentId={AGENT_ID} className="melos-chat" />;
}

export default function Page() {
  return (
    <main style={{ height: "100dvh", display: "flex", flexDirection: "column" }}>
      <CopilotKitProvider runtimeUrl="/api/copilotkit" agentId={AGENT_ID}>
        <CatalogChat />
      </CopilotKitProvider>
    </main>
  );
}
