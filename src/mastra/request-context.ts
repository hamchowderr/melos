import { RequestContext } from '@mastra/core/request-context';
import { z } from 'zod';
import { isWorkspaceRole, type WorkspaceRole } from '../lib/auth/permissions';
import type { TenantContext } from '../server/services/tenant-context';

/** The canonical tenant keys: the route sets them, tools read them (docs/CONTRACT.md §3.1, §7.1). */
const TENANT_KEYS = [
  'userId',
  'organizationId',
  'workspaceId',
  'workspaceRole',
  'requestId',
] as const;

const tenantContextSchema = z.object({
  userId: z.string().min(1),
  organizationId: z.string().min(1),
  workspaceId: z.string().min(1),
  workspaceRole: z.custom<WorkspaceRole>(isWorkspaceRole),
  requestId: z.string().min(1),
});

type ContextReader = { get(key: string): unknown };

/**
 * @ag-ui/mastra types `requestContext` as RequestContext<unknown>, which rejects a typed
 * RequestContext<T>. So the context is built untyped here and read back, validated, through
 * readTenantContext.
 */
export function createAgentRequestContext(tenant: TenantContext): RequestContext {
  const requestContext = new RequestContext();
  for (const key of TENANT_KEYS) requestContext.set(key, tenant[key]);
  return requestContext;
}

/** Reads the tenant a tool runs for. Throws when the route did not provide a valid one. */
export function readTenantContext(requestContext: ContextReader | undefined): TenantContext {
  const values = Object.fromEntries(TENANT_KEYS.map((key) => [key, requestContext?.get(key)]));
  const parsed = tenantContextSchema.safeParse(values);
  if (!parsed.success) {
    throw new Error(`Agent request context has no tenant: ${TENANT_KEYS.join(', ')} required.`);
  }
  return parsed.data;
}

/**
 * Memory is scoped per workspace and user: `<workspaceId>:<userId>` (§7.3, TEN-007). The route
 * always passes it, because @ag-ui/mastra falls back to the thread id as the resource.
 */
export function memoryResourceId(tenant: TenantContext): string {
  return `${tenant.workspaceId}:${tenant.userId}`;
}
