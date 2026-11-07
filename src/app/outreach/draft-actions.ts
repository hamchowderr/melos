'use server';

import { resolveWorkspaceAction } from '@/app/workspace-action';
import type { MessageDraftDTO, UpdateDraftInput } from '@/lib/dto/outreach';
import { updateMessageDraft } from '@/server/services/outreach/update-draft';

/** The saved draft, or the refusal code. */
export type DraftSaveResult = { ok: true; draft: MessageDraftDTO } | { ok: false; code: string };

/** Saves MessageDraftCard edits for the member (OUT-004, §7.1); the service checks outreach:draft. */
export async function saveMessageDraft(input: UpdateDraftInput): Promise<DraftSaveResult> {
  const workspace = await resolveWorkspaceAction();
  if (workspace.status !== 'ready') return { ok: false, code: workspace.status };
  const saved = await updateMessageDraft(workspace.tenant, input);
  return saved.ok ? { ok: true, draft: saved.value } : { ok: false, code: saved.error.code };
}
