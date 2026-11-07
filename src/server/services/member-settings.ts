import { and, eq } from 'drizzle-orm';
import { isTimeZone } from '../../lib/zoned-date';
import { controlDb } from '../db/client';
import { workspaceMemberSettings } from '../db/schema/control';
import { controlIntegrityGuard as guard } from './integrity-guard';
import type { TenantContext } from './tenant-context';

/**
 * The member's IANA timezone for "today" (P-24): their workspace_member_settings row, UTC when there
 * is none or it holds a name Intl refuses.
 */
export async function getMemberTimezone(
  tenant: Pick<TenantContext, 'organizationId' | 'userId'>,
): Promise<string> {
  const [row] = await controlDb
    .select({ timezone: workspaceMemberSettings.timezone })
    .from(workspaceMemberSettings)
    .where(
      and(
        eq(workspaceMemberSettings.organizationId, tenant.organizationId),
        eq(workspaceMemberSettings.userId, tenant.userId),
      ),
    );
  return row && isTimeZone(row.timezone) ? row.timezone : 'UTC';
}

/**
 * Stores the member's browser timezone the first time they open the workspace (P-24): a name Intl
 * refuses, or none, is stored as UTC. A member with a row keeps it, so the call writes at most once.
 * Returns the timezone in effect.
 */
export async function recordMemberTimezone(
  tenant: Pick<TenantContext, 'organizationId' | 'userId'>,
  browserTimezone: string | null | undefined,
): Promise<string> {
  const timezone = browserTimezone && isTimeZone(browserTimezone) ? browserTimezone : 'UTC';
  return controlDb.transaction(async (tx) => {
    const key = and(
      eq(workspaceMemberSettings.organizationId, tenant.organizationId),
      eq(workspaceMemberSettings.userId, tenant.userId),
    );
    const [row] = await tx.select().from(workspaceMemberSettings).where(key);
    if (row) return row.timezone;
    const { organizationId, userId } = tenant;
    await guard.insert(tx, workspaceMemberSettings, [
      { organizationId, userId, timezone, updatedAt: new Date().toISOString() },
    ]);
    return timezone;
  });
}

/** ONB-003: whether the member dismissed the getting-started checklist in this workspace. */
export async function isOnboardingDismissed(
  tenant: Pick<TenantContext, 'organizationId' | 'userId'>,
): Promise<boolean> {
  const [row] = await controlDb
    .select({ dismissedAt: workspaceMemberSettings.onboardingDismissedAt })
    .from(workspaceMemberSettings)
    .where(
      and(
        eq(workspaceMemberSettings.organizationId, tenant.organizationId),
        eq(workspaceMemberSettings.userId, tenant.userId),
      ),
    );
  return Boolean(row?.dismissedAt);
}

/**
 * ONB-003: hides the getting-started checklist for this member. The member's row is created first
 * from the browser timezone, as recordMemberTimezone does, so dismissing never pins it to UTC.
 */
export async function dismissOnboarding(
  tenant: Pick<TenantContext, 'organizationId' | 'userId'>,
  browserTimezone: string | null | undefined,
): Promise<void> {
  await recordMemberTimezone(tenant, browserTimezone);
  const at = new Date().toISOString();
  const member = eq(workspaceMemberSettings.userId, tenant.userId);
  const key = and(eq(workspaceMemberSettings.organizationId, tenant.organizationId), member);
  await controlDb.transaction((tx) =>
    guard.update(
      tx,
      workspaceMemberSettings,
      { onboardingDismissedAt: at, updatedAt: at },
      key ?? member,
    ),
  );
}
