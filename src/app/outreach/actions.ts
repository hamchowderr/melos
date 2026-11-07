'use server';

import { resolveWorkspaceAction } from '@/app/workspace-action';
import type {
  DraftMessageInput,
  MessageDraftDTO,
  MessageThreadDTO,
  SendResultDTO,
  UpdateDraftInput,
} from '@/lib/dto/outreach';
import { draftPitchMessage, getMessageDraft } from '@/server/services/outreach/drafts';
import { getMessageThread } from '@/server/services/outreach/replies';
import { sendMessage } from '@/server/services/outreach/send';
import { updateMessageDraft } from '@/server/services/outreach/update-draft';
import type { ServiceResult } from '@/server/services/service-result';

/** An outreach action's value, or the refusal code. */
export type OutreachResult<T> = { ok: true; value: T } | { ok: false; code: string };

async function run<T>(
  call: (tenant: Parameters<typeof getMessageDraft>[0]) => Promise<ServiceResult<T>>,
): Promise<OutreachResult<T>> {
  const workspace = await resolveWorkspaceAction();
  if (workspace.status !== 'ready') return { ok: false, code: 'NO_TENANT' };
  const result = await call(workspace.tenant);
  return result.ok ? { ok: true, value: result.value } : { ok: false, code: result.error.code };
}

/** A new draft on a pitch (OUT-001); outreach:draft. */
export async function createDraft(input: DraftMessageInput) {
  return run<MessageDraftDTO>((tenant) => draftPitchMessage(tenant, input));
}

/** One draft for the editor; outreach:draft. */
export async function loadDraft(messageId: string) {
  return run<MessageDraftDTO>((tenant) => getMessageDraft(tenant, messageId));
}

/** Saves subject, body and recipients (OUT-004); outreach:draft. */
export async function saveDraft(input: UpdateDraftInput) {
  return run<MessageDraftDTO>((tenant) => updateMessageDraft(tenant, input));
}

/** Sends a saved draft through the workspace's EmailTransport (OUT-002); outreach:send. */
export async function sendDraft(messageId: string) {
  return run<SendResultDTO>((tenant) => sendMessage(tenant, { messageId }));
}

/** A pitch's messages with their bodies (OUT-003), to read a sent message. */
export async function loadThread(messageId: string) {
  return run<MessageThreadDTO>((tenant) => getMessageThread(tenant, { messageId }));
}
