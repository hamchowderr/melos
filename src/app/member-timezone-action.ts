'use server';

import { resolveWorkspaceAction } from '@/app/workspace-action';
import { recordMemberTimezone } from '@/server/services/member-settings';

/** Records the browser's timezone for the active workspace member once (P-24). */
export async function recordTimezoneAction(browserTimezone: string): Promise<void> {
  const resolved = await resolveWorkspaceAction();
  if (resolved.status !== 'ready') return;
  await recordMemberTimezone(resolved.tenant, browserTimezone.slice(0, 64));
}
