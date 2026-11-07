import { and, eq } from 'drizzle-orm';
import { isTimeZone } from '../../lib/zoned-date';
import { controlDb } from '../db/client';
import { workspaceMemberSettings } from '../db/schema/control';
import type { TenantContext } from './tenant-context';

/**
 * The member's IANA timezone for "today" (P-24): their workspace_member_settings row, UTC when there
 * is none or it holds a name Intl refuses.
 */
export async function getMemberTimezone(tenant: TenantContext): Promise<string> {
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
