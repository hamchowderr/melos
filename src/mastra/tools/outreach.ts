import { createTool } from '@mastra/core/tools';
import { approvalDecisionSchema, approvalRequestSchema } from '../../lib/agent/approval';
import {
  DRAFT_PITCH_MESSAGE_TOOL_NAME,
  draftPitchMessageInputSchema,
  SEND_MESSAGE_TOOL_NAME,
  sendMessageInputSchema,
  UPDATE_MESSAGE_DRAFT_TOOL_NAME,
  updateMessageDraftInputSchema,
} from '../../lib/agent/outreach-tools';
import { toolResultSchema } from '../../lib/agent/tool-result';
import type { MessageDraftDTO, SendResultDTO } from '../../lib/dto/outreach';
import { draftPitchMessage } from '../../server/services/outreach/drafts';
import { previewSend, sendMessage, storedSendResult } from '../../server/services/outreach/send';
import { updateMessageDraft } from '../../server/services/outreach/update-draft';
import { approvedWrite } from './approval';
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

/** sendMessage's §3.6 model fields: the outcome, without addresses. */
export const summarizeSend = (result: SendResultDTO) => ({
  messageId: result.messageId,
  status: result.status,
  provider: result.provider,
  sentAt: result.sentAt,
  failureReason: result.failureReason,
});

/** Every agent send asks first; the approval binds the draft's beforeHash and contentHash (§7.4). */
const approvedSend = approvedWrite<{ messageId: string }, SendResultDTO>({
  toolName: SEND_MESSAGE_TOOL_NAME,
  kind: 'external_send',
  permissions: { outreach: ['send'] },
  preview: async (tenant, { messageId }) => {
    const preview = await previewSend(tenant, messageId);
    if (!preview.ok) return preview;
    const { to, ...shown } = preview.value;
    const subject = shown.before[0]?.label ?? '';
    const summary = `Send "${subject}" to ${to.join(', ')}.`;
    return { ok: true, value: { ...shown, summary, reasons: ['This sends a real email.'] } };
  },
  apply: (tenant, { messageId }, beforeHash, origin, request) =>
    sendMessage(
      tenant,
      { messageId, expected: { beforeHash, contentHash: request.contentHash ?? '' } },
      origin,
    ),
});

export const sendMessageTool = createTool({
  id: SEND_MESSAGE_TOOL_NAME,
  description:
    'Send a drafted email. Always asks the member to approve the exact draft first; an edit after that cancels the send. A message already sent returns its result.',
  inputSchema: sendMessageInputSchema,
  outputSchema: toolResultSchema<SendResultDTO>(),
  suspendSchema: approvalRequestSchema,
  resumeSchema: approvalDecisionSchema,
  execute: async (input, context) => {
    const stored = await runTool(context, (tenant) => storedSendResult(tenant, input.messageId));
    if (stored.status === 'ok' && stored.value)
      return { status: 'ok' as const, value: stored.value };
    return approvedSend(input, context);
  },
  toModelOutput: modelOutput(summarizeSend),
});
