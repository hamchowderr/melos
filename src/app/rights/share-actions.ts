'use server';

import { resolveWorkspaceAction } from '@/app/workspace-action';
import type { WriterSharesInput } from '@/lib/dto/rights';
import { updateWriterShares } from '@/server/services/rights/shares';

/** A save that was stored, or the refusal code, or why the request has no workspace to write. */
export type SaveSharesResult = { ok: true } | { ok: false; code: string };

/**
 * Replaces a song's writer set for the tenant resolved from this request (§7.1). Save is the
 * confirmation (§6.3); `expectedBeforeHash` is the hash the editor read at load, so a set someone
 * else changed since is STATE_CHANGED. updateWriterShares checks rights:update and every share.
 */
export async function saveWriterShares(input: WriterSharesInput): Promise<SaveSharesResult> {
  const workspace = await resolveWorkspaceAction();
  if (workspace.status !== 'ready') return { ok: false, code: workspace.status };
  const result = await updateWriterShares(workspace.tenant, input);
  return result.ok ? { ok: true } : { ok: false, code: result.error.code };
}
