'use server';

import { revalidatePath } from 'next/cache';
import { resolveWorkspaceAction } from '@/app/workspace-action';
import { dismissOnboarding } from '@/server/services/member-settings';

/** ONB-003: hides the getting-started checklist for the signed-in member of this workspace. */
export async function dismissOnboardingAction(browserTimezone: string): Promise<boolean> {
  const workspace = await resolveWorkspaceAction();
  if (workspace.status !== 'ready') return false;
  await dismissOnboarding(workspace.tenant, browserTimezone.slice(0, 64));
  revalidatePath('/today');
  return true;
}
