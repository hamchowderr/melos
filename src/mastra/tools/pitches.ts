import { createTool } from '@mastra/core/tools';
import {
  GET_MESSAGE_THREAD_TOOL_NAME,
  GET_PITCH_TOOL_NAME,
  GET_TODAY_WORKSPACE_TOOL_NAME,
  getMessageThreadInputSchema,
  getPitchInputSchema,
  getTodayWorkspaceInputSchema,
  SEARCH_PITCHES_TOOL_NAME,
  searchPitchesInputSchema,
} from '../../lib/agent/pitch-tools';
import { toolResultSchema } from '../../lib/agent/tool-result';
import type { MessageThreadDTO } from '../../lib/dto/outreach';
import type { PitchDTO, PitchSummary, TodayWorkspaceDTO } from '../../lib/dto/pitches';
import { getMessageThread } from '../../server/services/outreach/replies';
import { getPitch, searchPitches } from '../../server/services/pitches/read';
import { getTodayWorkspace } from '../../server/services/pitches/today';
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

/** getMessageThread's §3.6 model fields, per message; bodies and addresses stay in the UI. */
export const summarizeThread = (thread: MessageThreadDTO) => ({
  pitchId: thread.pitchId,
  messages: thread.messages.map((message) => ({
    messageId: message.messageId,
    direction: message.direction,
    status: message.status,
    subject: message.subject,
    ...(message.direction === 'inbound'
      ? { receivedAt: message.receivedAt }
      : { sentAt: message.sentAt }),
  })),
});

export const getMessageThreadTool = createTool({
  id: GET_MESSAGE_THREAD_TOOL_NAME,
  description:
    "Every message on a pitch in time order, sent and received, given a pitch id or one of its message ids. Use it to read a contact's reply.",
  inputSchema: getMessageThreadInputSchema,
  outputSchema: toolResultSchema<MessageThreadDTO>(),
  execute: (input, context) => runTool(context, (tenant) => getMessageThread(tenant, input)),
  toModelOutput: modelOutput(summarizeThread),
});

/** getTodayWorkspace's §3.6 model fields: each due cell, then counts of the other sections. */
export const summarizeToday = (today: TodayWorkspaceDTO) => ({
  date: today.date,
  followUpsDue: today.followUpsDue.map((cell) => ({
    pitchItemId: cell.pitchItemId,
    pitchId: cell.pitchId,
    contactName: cell.contactName,
    itemTitle: cell.itemTitle,
    currentStatus: cell.currentStatus,
    priorityRank: cell.priorityRank,
  })),
  recentReplyCount: today.recentReplies.length,
  readinessIssueCount: today.readinessIssues.recordings.reduce(
    (count, recording) => count + recording.issues.length,
    0,
  ),
  readyToPitchCount: today.readyToPitch.length,
});

export const getTodayWorkspaceTool = createTool({
  id: GET_TODAY_WORKSPACE_TOOL_NAME,
  description:
    "The member's day: follow-ups due in priority order, recent replies, readiness issues and songs ready to pitch. Use it for 'what should I do today?'.",
  inputSchema: getTodayWorkspaceInputSchema,
  outputSchema: toolResultSchema<TodayWorkspaceDTO>(),
  execute: (input, context) => runTool(context, (tenant) => getTodayWorkspace(tenant, input)),
  toModelOutput: modelOutput(summarizeToday),
});
