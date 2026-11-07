/**
 * Outreach DTOs (docs/CONTRACT.md §3.3, §3.4, §7.5). Types only, with no server import, so client
 * components can import them.
 */

export type MessagePurpose = 'initial' | 'follow_up' | 'reply';
export type RecipientType = 'to' | 'cc' | 'bcc';

/** A recipient as stored: the contact method it came from, while it exists, and its address. */
export type MessageRecipientDTO = { contactMethodId: string | null; address: string };

/**
 * MessageDraftDTO (§3.4, OUT-001): an outbound draft with its recipients, `contentHash` (§7.4) and
 * the facts it was drafted from: the contact, the pitch's songs with their primary links and the
 * attached generated report.
 */
export type MessageDraftDTO = {
  messageId: string;
  pitchId: string;
  purpose: MessagePurpose;
  status: 'draft';
  subject: string;
  bodyText: string;
  to: MessageRecipientDTO[];
  cc: MessageRecipientDTO[];
  bcc: MessageRecipientDTO[];
  contentHash: string;
  updatedAt: string;
  sourceFacts: {
    contactName: string;
    items: {
      itemType: 'composition' | 'recording';
      itemId: string;
      title: string;
      primaryLink: string | null;
    }[];
    generatedReportId: string | null;
    replyToMessageId: string | null;
  };
};

/** draftPitchMessage input (§3.3). Recipients default to the pitch contact's primary email. */
export type DraftMessageInput = {
  pitchId: string;
  purpose: 'initial' | 'follow_up';
  subject: string;
  bodyText: string;
  replyToMessageId?: string | null;
  generatedReportId?: string | null;
};

/** updateMessageDraft input (§3.3, OUT-004): each list replaces that recipient type's set. */
export type UpdateDraftInput = {
  messageId: string;
  subject?: string;
  bodyText?: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
};

/** SendResultDTO (§3.4, OUT-002): the outcome of sendMessage, stored on the message. */
export type SendResultDTO = {
  messageId: string;
  status: 'sent' | 'failed';
  provider: 'sandbox' | 'resend' | null;
  providerMessageId: string | null;
  sentAt: string | null;
  failureReason: string | null;
};

/** One message in a thread (§3.4 MessageThreadDTO), with its body and recipients. */
export type ThreadMessageDTO = {
  messageId: string;
  direction: 'outbound' | 'inbound';
  purpose: MessagePurpose | null;
  status: 'draft' | 'queued' | 'sending' | 'sent' | 'failed' | 'received';
  subject: string | null;
  bodyText: string | null;
  from: string | null;
  to: string[];
  cc: string[];
  inReplyToMessageId: string | null;
  sentAt: string | null;
  receivedAt: string | null;
  failureReason: string | null;
  createdAt: string;
};

/** MessageThreadDTO (§3.4, OUT-003): a pitch's messages in time order. */
export type MessageThreadDTO = { pitchId: string; messages: ThreadMessageDTO[] };
