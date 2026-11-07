'use server';

import { revalidatePath } from 'next/cache';
import { resolveWorkspaceAction } from '@/app/workspace-action';
import { setWorkspaceType } from '@/server/services/onboarding/workspace-type';

/** ONB-002: changes the active workspace's type; the service checks the role. */
export async function saveWorkspaceType(
  workspaceType: string,
): Promise<{ ok: true } | { ok: false; code: string }> {
  const workspace = await resolveWorkspaceAction();
  if (workspace.status !== 'ready') return { ok: false, code: workspace.status };
  const result = await setWorkspaceType(workspace.tenant, workspaceType);
  if (!result.ok) return { ok: false, code: result.error.code };
  revalidatePath('/', 'layout');
  return { ok: true };
}
