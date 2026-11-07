import { z } from 'zod';

/** Outreach tool names and inputs (docs/CONTRACT.md §3.3). Zod only. */
export const DRAFT_PITCH_MESSAGE_TOOL_NAME = 'draftPitchMessage';
export const UPDATE_MESSAGE_DRAFT_TOOL_NAME = 'updateMessageDraft';
export const SEND_MESSAGE_TOOL_NAME = 'sendMessage';

const subject = z.string().min(1).max(300);
const bodyText = z.string().min(1).max(50_000).describe('Plain text email body.');
const methodIds = z.array(z.string().min(1)).max(50).describe('Email contact method ids.');

export const draftPitchMessageInputSchema = z.object({
  pitchId: z.string().min(1),
  purpose: z.enum(['initial', 'follow_up']),
  subject,
  bodyText,
  replyToMessageId: z.string().min(1).optional(),
  generatedReportId: z.string().min(1).optional().describe('A generateReport snapshot to attach.'),
});

export const updateMessageDraftInputSchema = z.object({
  messageId: z.string().min(1),
  subject: subject.optional(),
  bodyText: bodyText.optional(),
  to: methodIds.optional(),
  cc: methodIds.optional(),
  bcc: methodIds.optional(),
});

export const sendMessageInputSchema = z.object({ messageId: z.string().min(1) });
