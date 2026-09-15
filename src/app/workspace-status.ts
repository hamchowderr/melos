import type {
  TenantResolution,
  UnavailableWorkspaceStatus,
} from '@/server/services/tenant-context';

/**
 * Why a resolved request's workspace cannot serve it, for pages and Server Actions alike (§7.1): a
 * registry row that serves no request keeps its status, and a workspace never provisioned is failed.
 * Null for every other resolution.
 */
export function notReadyStatus(resolution: TenantResolution): UnavailableWorkspaceStatus | null {
  if (resolution.status === 'workspace-unavailable') return resolution.workspaceStatus;
  return resolution.status === 'workspace-not-provisioned' ? 'failed' : null;
}
