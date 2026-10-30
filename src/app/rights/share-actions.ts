'use server';

import { resolveWorkspaceAction } from '@/app/workspace-action';
import type { MasterSharesInput, PublishingSharesInput, WriterSharesInput } from '@/lib/dto/rights';
import { updateMasterShares, updatePublishingShares } from '@/server/services/rights/holder-shares';
import { updateWriterShares } from '@/server/services/rights/shares';
import type { ServiceResult } from '@/server/services/service-result';

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

/** A holder-set save's refusal also names the VALIDATION reason, such as mixes_world_and_countries. */
export type SaveHoldersResult = { ok: true } | { ok: false; code: string; reason?: string };

const holderOutcome = (result: ServiceResult<unknown>): SaveHoldersResult =>
  result.ok
    ? { ok: true }
    : {
        ok: false,
        code: result.error.code,
        ...('reason' in result.error ? { reason: String(result.error.reason) } : {}),
      };

/** Replaces one territory's publishing set (RGT-002, RGT-007); updatePublishingShares checks it. */
export async function savePublishingShares(
  input: PublishingSharesInput,
): Promise<SaveHoldersResult> {
  const workspace = await resolveWorkspaceAction();
  if (workspace.status !== 'ready') return { ok: false, code: workspace.status };
  return holderOutcome(await updatePublishingShares(workspace.tenant, input));
}

/** Replaces a recording's master set (RGT-003); updateMasterShares checks it. */
export async function saveMasterShares(input: MasterSharesInput): Promise<SaveHoldersResult> {
  const workspace = await resolveWorkspaceAction();
  if (workspace.status !== 'ready') return { ok: false, code: workspace.status };
  return holderOutcome(await updateMasterShares(workspace.tenant, input));
}
