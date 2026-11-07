import { createTool } from '@mastra/core/tools';
import {
  ADD_PITCH_ITEM_TOOL_NAME,
  ADD_PITCH_NOTE_TOOL_NAME,
  addPitchItemInputSchema,
  addPitchNoteInputSchema,
  CREATE_PITCH_TOOL_NAME,
  createPitchInputSchema,
} from '../../lib/agent/pitch-write-tools';
import { toolResultSchema } from '../../lib/agent/tool-result';
import type { PitchDTO } from '../../lib/dto/pitches';
import { addPitchNote } from '../../server/services/pitches/status';
import { addPitchItem, createPitch } from '../../server/services/pitches/write';
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
