'use server';

import { resolveWorkspaceAction } from '@/app/workspace-action';
import { SELF_PARTY_SIDES, type SelfPartiesInput } from '@/lib/dto/self-parties';
import { updateSelfParties } from '@/server/services/rights/self-parties';

/** A save that was stored, or the refusal code, or why the request has no workspace to write. */
export type SaveSelfPartiesResult = { ok: true } | { ok: false; code: string };

/**
 * Saves each side's party id for the tenant resolved from this request (§7.1). The client sends the
 * input, so anything but a non-empty string clears a side; updateSelfParties checks rights:update. A
 * database failure throws WorkspaceConnectionError, which carries no database message (§7.2).
 */
export async function saveSelfParties(input: SelfPartiesInput): Promise<SaveSelfPartiesResult> {
  const workspace = await resolveWorkspaceAction();
  if (workspace.status !== 'ready') return { ok: false, code: workspace.status };
  const id = (value: unknown) => (typeof value === 'string' && value ? value : null);
  const sides = SELF_PARTY_SIDES.map((side) => [side, id(input?.[side])]);
  const result = await updateSelfParties(workspace.tenant, Object.fromEntries(sides));
  return result.ok ? { ok: true } : { ok: false, code: result.error.code };
}
