import { Agent } from '@mastra/core/agent';
import type { MastraModelConfig } from '@mastra/core/llm';
import { WORKSPACE_AGENT_ID } from '../../lib/agent/contract';
import { focusInstruction } from '../focus';
import { createAgentMemory } from '../memory';
import { getMusicWorkspaceTool, searchMusicTool } from '../tools/catalog';
import { getContactTool, searchContactsTool, searchPitchEligibilityTool } from '../tools/contacts';
import { pingTool } from '../tools/ping';
import {
  addPitchItemTool,
  addPitchNoteTool,
  createPitchTool,
  transitionPitchStatusTool,
} from '../tools/pitch-writes';
import {
  getMessageThreadTool,
  getPitchTool,
  getTodayWorkspaceTool,
  searchPitchesTool,
} from '../tools/pitches';
import { generateReportTool, listReportTemplatesTool, previewReportTool } from '../tools/reports';
import {
  attestRepresentationTool,
  updateLicensingContactsTool,
} from '../tools/representation-writes';
import {
  getReadinessIssuesTool,
  getRightsSummaryTool,
  proposeDefaultOwnershipTool,
} from '../tools/rights';
import {
  updateMasterSharesTool,
  updatePublishingSharesTool,
  updateWriterSharesTool,
} from '../tools/rights-writes';

/** The agent's standing rules: name resolution (§3.5), references (§3.7) and tool-only facts. */
export const WORKSPACE_AGENT_INSTRUCTIONS = [
  'You are Melos, the workspace assistant for a music catalog, rights and pitching app.',
  'Catalog, rights and contact facts come only from tools. Never invent them.',
  'Working memory holds only the member preferences in its schema: tone, signature and preferred report preset.',
  'Never store song, rights, contact or pitch facts in working memory.',
  'Tools take ids. To act on a song the user names, call searchMusic first, then:',
  'if exactly one result matched its title or an alternate title exactly, use it;',
  'if nothing matched exactly and there is exactly one result, use it;',
  'otherwise list the candidates and ask which one the user means.',
  'When a tool needs a recording, use the song primaryRecordingId; if it is null, ask which recording.',
  '"This" or "that song" means the focused entity in the context, then the most recent result in this chat that fits, otherwise ask.',
  'To act on a person the user names, call searchContacts first and resolve one contact the same way; ask when several match.',
  '"Who hasn\'t heard this?" means searchPitchEligibility for that song.',
  'proposeDefaultOwnership only proposes; never say a proposal was saved.',
  'Reports: you see only their length, so never quote or summarize report text; the member reads it in the card.',
  'createPitch records a planned pitch and sends nothing; say so, and never say a pitch was sent.',
  'Marking a pitch won, lost or archived waits for the member to approve it; never say it changed before the result says so.',
  'Rights changes (shares, representation, licensing contacts) always wait for the member to approve them on a confirmation card: call the tool with the full proposed set and never say a change was saved before its result says so.',
  'To change one share in a writer, publishing or master set: read the rights first; with exactly one other holder, give that holder 10000 minus the new share; with two or more other holders, ask how to rebalance.',
  'DECLINED means the member did not approve and nothing changed. STATE_CHANGED means the rights changed meanwhile: read them again and propose again.',
  'A tool result with status "error" carries a code: explain it in one plain sentence.',
  'When the user asks you to ping, test or check the connection, call the ping tool, then confirm in one short sentence.',
].join(' ');

/**
 * The agent's tools, keyed by canonical tool name (§3.3). AIMock fixtures may call only these, and
 * each one has a chat renderer (TST-AI-004, tests/unit/agent-fixtures.test.ts).
 */
export const WORKSPACE_AGENT_TOOLS = {
  ping: pingTool,
  searchMusic: searchMusicTool,
  getMusicWorkspace: getMusicWorkspaceTool,
  getRightsSummary: getRightsSummaryTool,
  getReadinessIssues: getReadinessIssuesTool,
  proposeDefaultOwnership: proposeDefaultOwnershipTool,
  searchPitches: searchPitchesTool,
  getPitch: getPitchTool,
  searchContacts: searchContactsTool,
  getContact: getContactTool,
  searchPitchEligibility: searchPitchEligibilityTool,
  listReportTemplates: listReportTemplatesTool,
  previewReport: previewReportTool,
  generateReport: generateReportTool,
  getMessageThread: getMessageThreadTool,
  getTodayWorkspace: getTodayWorkspaceTool,
  createPitch: createPitchTool,
  addPitchItem: addPitchItemTool,
  addPitchNote: addPitchNoteTool,
  transitionPitchStatus: transitionPitchStatusTool,
  updateWriterShares: updateWriterSharesTool,
  updatePublishingShares: updatePublishingSharesTool,
  updateMasterShares: updateMasterSharesTool,
  attestRepresentation: attestRepresentationTool,
  updateLicensingContacts: updateLicensingContactsTool,
};

export function createWorkspaceAgent(model: MastraModelConfig): Agent {
  return new Agent({
    id: WORKSPACE_AGENT_ID,
    name: 'Melos',
    // The focused entity (U-04) reaches the model only through this line.
    instructions: ({ requestContext }) =>
      [WORKSPACE_AGENT_INSTRUCTIONS, focusInstruction(requestContext)].filter(Boolean).join(' '),
    model,
    tools: WORKSPACE_AGENT_TOOLS,
    memory: createAgentMemory(),
    // Mastra stops at 5 steps by default without warning; give tool loops explicit headroom.
    defaultOptions: { maxSteps: 8 },
  });
}
