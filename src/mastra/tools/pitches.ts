import { createTool } from '@mastra/core/tools';
import {
  GET_PITCH_TOOL_NAME,
  getPitchInputSchema,
  SEARCH_PITCHES_TOOL_NAME,
  searchPitchesInputSchema,
} from '../../lib/agent/pitch-tools';
import { toolResultSchema } from '../../lib/agent/tool-result';
import type { PitchDTO, PitchSummary } from '../../lib/dto/pitches';
import { getPitch, searchPitches } from '../../server/services/pitches/read';
import { modelOutput, runTool } from './run-tool';

/** searchPitches's §3.6 model fields, per cell. */
export const summarizePitches = (cells: PitchSummary[]) =>
  cells.map((cell) => ({
    pitchId: cell.pitchId,
    pitchItemId: cell.pitchItemId,
    contactId: cell.contactId,
    contactName: cell.contactName,
    itemType: cell.itemType,
    itemId: cell.itemId,
    itemTitle: cell.itemTitle,
    currentStatus: cell.currentStatus,
    nextFollowUpAt: cell.nextFollowUpAt,
    followUpDue: cell.followUpDue,
    lastOutboundMessageId: cell.lastOutboundMessageId,
  }));

/** getPitch's §3.6 model fields: the pitch, its cells and its last sent outbound message. */
export const summarizePitch = (pitch: PitchDTO) => {
  const last = pitch.messages
    .filter((message) => message.direction === 'outbound' && message.status === 'sent')
    .at(-1);
  return {
    pitchId: pitch.pitchId,
    contactId: pitch.contactId,
    contactName: pitch.contactName,
    subject: pitch.subject,
    items: pitch.items.map(({ pitchItemId, itemId, itemTitle, currentStatus }) => ({
      pitchItemId,
      itemId,
      itemTitle,
      currentStatus,
    })),
    lastOutboundMessage: last
      ? { messageId: last.messageId, subject: last.subject, sentAt: last.sentAt }
      : null,
    nextFollowUpAt: pitch.nextFollowUpAt,
  };
};

export const searchPitchesTool = createTool({
  id: SEARCH_PITCHES_TOOL_NAME,
  description:
    'Find pitch cells (one song pitched to one contact) by status, contact, song, or follow-up due date. Newest pitch first.',
  inputSchema: searchPitchesInputSchema,
  outputSchema: toolResultSchema<PitchSummary[]>(),
  execute: (input, context) => runTool(context, (tenant) => searchPitches(tenant, input)),
  toModelOutput: modelOutput(summarizePitches),
});

export const getPitchTool = createTool({
  id: GET_PITCH_TOOL_NAME,
  description:
    "One pitch to one contact: every song in it with its status, the follow-up date, and the pitch's timeline of events and messages.",
  inputSchema: getPitchInputSchema,
  outputSchema: toolResultSchema<PitchDTO>(),
  execute: ({ pitchId }, context) => runTool(context, (tenant) => getPitch(tenant, pitchId)),
  toModelOutput: modelOutput(summarizePitch),
});
