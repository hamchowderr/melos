import { createTool } from '@mastra/core/tools';
import {
  DRAFT_PITCH_MESSAGE_TOOL_NAME,
  draftPitchMessageInputSchema,
  UPDATE_MESSAGE_DRAFT_TOOL_NAME,
  updateMessageDraftInputSchema,
} from '../../lib/agent/outreach-tools';
import { toolResultSchema } from '../../lib/agent/tool-result';
import type { MessageDraftDTO } from '../../lib/dto/outreach';
import { draftPitchMessage } from '../../server/services/outreach/drafts';
import { updateMessageDraft } from '../../server/services/outreach/update-draft';
import { modelOutput, runTool } from './run-tool';

const AGENT = { type: 'agent' as const };

/** The draft tools' §3.6 model fields; recipients by display name, never the address. */
export const summarizeDraft = (draft: MessageDraftDTO) => ({
  messageId: draft.messageId,
  pitchId: draft.pitchId,
  purpose: draft.purpose,
  subject: draft.subject,
  status: draft.status,
  // The to recipient is the pitch contact (§3.3); cc and bcc are counted, not named.
  to: draft.to.length ? draft.sourceFacts.contactName : null,
  ccCount: draft.cc.length,
  bccCount: draft.bcc.length,
});

export const draftPitchMessageTool = createTool({
  id: DRAFT_PITCH_MESSAGE_TOOL_NAME,
  description:
    "Draft an email on a pitch (the first pitch or a follow-up) to the contact's primary email. Only saves a draft; sendMessage sends it after approval.",
  inputSchema: draftPitchMessageInputSchema,
  outputSchema: toolResultSchema<MessageDraftDTO>(),
  execute: (input, context) =>
    runTool(context, (tenant) => draftPitchMessage(tenant, input, AGENT)),
  toModelOutput: modelOutput(summarizeDraft),
});

export const updateMessageDraftTool = createTool({
  id: UPDATE_MESSAGE_DRAFT_TOOL_NAME,
  description:
    "Change a draft's subject, body or recipient lists (email contact method ids). Only a draft can change.",
  inputSchema: updateMessageDraftInputSchema,
  outputSchema: toolResultSchema<MessageDraftDTO>(),
  execute: (input, context) =>
    runTool(context, (tenant) => updateMessageDraft(tenant, input, AGENT)),
  toModelOutput: modelOutput(summarizeDraft),
});
