import { createTool } from '@mastra/core/tools';
import { approvalDecisionSchema, approvalRequestSchema } from '../../lib/agent/approval';
import {
  ADD_PITCH_ITEM_TOOL_NAME,
  ADD_PITCH_NOTE_TOOL_NAME,
  addPitchItemInputSchema,
  addPitchNoteInputSchema,
  CREATE_PITCH_TOOL_NAME,
  createPitchInputSchema,
  TRANSITION_PITCH_STATUS_TOOL_NAME,
  transitionPitchStatusInputSchema,
} from '../../lib/agent/pitch-write-tools';
import { toolResultSchema } from '../../lib/agent/tool-result';
import { type PitchDTO, TERMINAL_STATUSES, type TransitionInput } from '../../lib/dto/pitches';
import {
  addPitchNote,
  previewTransition,
  transitionPitchStatus,
} from '../../server/services/pitches/status';
import { addPitchItem, createPitch } from '../../server/services/pitches/write';
import { approvedWrite } from './approval';
import { summarizePitch } from './pitches';
import { modelOutput, runTool } from './run-tool';

/** Draft writes (§3.3): they run without approval and are audited as the agent's. */
const AGENT = { type: 'agent' as const };

export const createPitchTool = createTool({
  id: CREATE_PITCH_TOOL_NAME,
  description:
    'Start a pitch of one or more songs to one contact, with an optional subject and opening note. Each song starts as a draft; nothing is sent.',
  inputSchema: createPitchInputSchema,
  outputSchema: toolResultSchema<PitchDTO>(),
  execute: (input, context) => runTool(context, (tenant) => createPitch(tenant, input, AGENT)),
  toModelOutput: modelOutput(summarizePitch),
});

export const addPitchItemTool = createTool({
  id: ADD_PITCH_ITEM_TOOL_NAME,
  description: 'Add one more song to an existing pitch. Nothing is sent.',
  inputSchema: addPitchItemInputSchema,
  outputSchema: toolResultSchema<PitchDTO>(),
  execute: (input, context) => runTool(context, (tenant) => addPitchItem(tenant, input, AGENT)),
  toModelOutput: modelOutput(summarizePitch),
});

export const addPitchNoteTool = createTool({
  id: ADD_PITCH_NOTE_TOOL_NAME,
  description:
    'Add a note to a pitch, or to one song in it, and optionally set the next follow-up date.',
  inputSchema: addPitchNoteInputSchema,
  outputSchema: toolResultSchema<PitchDTO>(),
  execute: (input, context) => runTool(context, (tenant) => addPitchNote(tenant, input, AGENT)),
  toModelOutput: modelOutput(summarizePitch),
});

/** A terminal move (won, lost, archived) asks first (P-07, §6.3); the request names the cell. */
const terminalMove = approvedWrite<TransitionInput, PitchDTO>({
  toolName: TRANSITION_PITCH_STATUS_TOOL_NAME,
  kind: 'terminal_status',
  permissions: { pitch: ['update'] },
  preview: async (tenant, input) => {
    const preview = await previewTransition(tenant, input);
    if (!preview.ok) return preview;
    const { pitchId: _, ...shown } = preview.value;
    const [before] = shown.before;
    const [after] = shown.after;
    const summary = `Move ${before.label} from ${before.detail} to ${after.detail}.`;
    return { ok: true, value: { ...shown, summary } };
  },
  apply: (tenant, input, expectedBeforeHash, origin) =>
    transitionPitchStatus(tenant, { ...input, expectedBeforeHash }, origin),
});

export const transitionPitchStatusTool = createTool({
  id: TRANSITION_PITCH_STATUS_TOOL_NAME,
  description:
    'Move one song of a pitch to a new status. Won, lost and archived always ask the member to approve first; other moves save at once.',
  inputSchema: transitionPitchStatusInputSchema,
  outputSchema: toolResultSchema<PitchDTO>(),
  suspendSchema: approvalRequestSchema,
  resumeSchema: approvalDecisionSchema,
  execute: (input, context) =>
    TERMINAL_STATUSES.includes(input.toStatus)
      ? terminalMove(input, context)
      : runTool(context, (tenant) => transitionPitchStatus(tenant, input, AGENT)),
  toModelOutput: modelOutput(summarizePitch),
});
