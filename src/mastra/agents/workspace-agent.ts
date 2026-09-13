import { Agent } from '@mastra/core/agent';
import type { MastraModelConfig } from '@mastra/core/llm';
import { Memory } from '@mastra/memory';
import { WORKSPACE_AGENT_ID } from '../../lib/agent/contract';
import { pingTool } from '../tools/ping';

export function createWorkspaceAgent(model: MastraModelConfig): Agent {
  return new Agent({
    id: WORKSPACE_AGENT_ID,
    name: 'Melos',
    instructions: [
      'You are Melos, the workspace assistant for a music catalog, rights and pitching app.',
      'When the user asks you to ping, test or check the connection, call the ping tool,',
      'then confirm in one short sentence. Never invent catalog, rights or contact data.',
    ].join(' '),
    model,
    tools: { ping: pingTool },
    memory: new Memory({ options: { lastMessages: 20 } }),
    // Mastra stops at 5 steps by default without warning; give tool loops explicit headroom.
    defaultOptions: { maxSteps: 8 },
  });
}
