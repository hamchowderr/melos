import { Agent } from '@mastra/core/agent';
import type { MastraModelConfig } from '@mastra/core/llm';
import { Memory } from '@mastra/memory';
import { WORKSPACE_AGENT_ID } from '../../lib/agent/contract';
import { getMusicWorkspaceTool, searchMusicTool } from '../tools/catalog';
import { pingTool } from '../tools/ping';
import {
  getReadinessIssuesTool,
  getRightsSummaryTool,
  proposeDefaultOwnershipTool,
} from '../tools/rights';

/** The agent's standing rules: name resolution (§3.5), references (§3.7) and tool-only facts. */
export const WORKSPACE_AGENT_INSTRUCTIONS = [
  'You are Melos, the workspace assistant for a music catalog, rights and pitching app.',
  'Catalog, rights and contact facts come only from tools. Never invent or remember them.',
  'Tools take ids. To act on a song the user names, call searchMusic first, then:',
  'if exactly one result matched its title or an alternate title exactly, use it;',
  'if nothing matched exactly and there is exactly one result, use it;',
  'otherwise list the candidates and ask which one the user means.',
  'When a tool needs a recording, use the song primaryRecordingId; if it is null, ask which recording.',
  '"This" or "that song" means the focused entity in the context, then the most recent result in this chat that fits, otherwise ask.',
  'proposeDefaultOwnership only proposes; never say a proposal was saved.',
  'A tool result with status "error" carries a code: explain it in one plain sentence.',
  'When the user asks you to ping, test or check the connection, call the ping tool, then confirm in one short sentence.',
].join(' ');

export function createWorkspaceAgent(model: MastraModelConfig): Agent {
  return new Agent({
    id: WORKSPACE_AGENT_ID,
    name: 'Melos',
    instructions: WORKSPACE_AGENT_INSTRUCTIONS,
    model,
    tools: {
      ping: pingTool,
      searchMusic: searchMusicTool,
      getMusicWorkspace: getMusicWorkspaceTool,
      getRightsSummary: getRightsSummaryTool,
      getReadinessIssues: getReadinessIssuesTool,
      proposeDefaultOwnership: proposeDefaultOwnershipTool,
    },
    memory: new Memory({ options: { lastMessages: 20 } }),
    // Mastra stops at 5 steps by default without warning; give tool loops explicit headroom.
    defaultOptions: { maxSteps: 8 },
  });
}
