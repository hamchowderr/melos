'use server';

import { resolveWorkspaceAction } from '@/app/workspace-action';
import type { DraftMessageInput, MessageDraftDTO, UpdateDraftInput } from '@/lib/dto/outreach';
import { draftPitchMessage, getMessageDraft } from '@/server/services/outreach/drafts';
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

export async function loadDraft(messageId: string) {
  return run<MessageDraftDTO>((tenant) => getMessageDraft(tenant, messageId));
}

/** Saves subject, body and recipients (OUT-004); outreach:draft. */
export async function saveDraft(input: UpdateDraftInput) {
  return run<MessageDraftDTO>((tenant) => updateMessageDraft(tenant, input));
}
