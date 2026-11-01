'use client';

import { HttpAgent } from '@ag-ui/client';
import { CopilotKitProvider } from '@copilotkit/react-core/v2';
import { useState } from 'react';
import { Chat } from '@/components/chat/workspace-chat';
import { WORKSPACE_AGENT_ID } from '@/lib/agent/contract';

/**
 * The real chat surface wired straight to an AG-UI endpoint instead of the Melos runtime, so
 * AGUIMock can drive the renderers with no Mastra, model or workspace behind them (TST-AI-003).
 */
export function AguiHarness({ agentUrl }: { agentUrl: string }) {
  const [agents] = useState(() => ({ [WORKSPACE_AGENT_ID]: new HttpAgent({ url: agentUrl }) }));
  return (
    <CopilotKitProvider selfManagedAgents={agents} agentId={WORKSPACE_AGENT_ID}>
      <div className="flex h-dvh flex-col p-4">
        <Chat />
      </div>
    </CopilotKitProvider>
  );
}
