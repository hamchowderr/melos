import { RequestContext } from '@mastra/core/request-context';
import { z } from 'zod';

export const AGENT_CONTEXT_KEYS = {
  userId: 'userId',
  activeOrganizationId: 'activeOrganizationId',
} as const;

const agentTenantContextSchema = z.object({
  userId: z.string().min(1),
  activeOrganizationId: z.string().min(1),
});

export type AgentTenantContext = z.infer<typeof agentTenantContextSchema>;

type ContextReader = { get(key: string): unknown };

/**
 * @ag-ui/mastra types `requestContext` as RequestContext<unknown>, which rejects a typed
 * RequestContext<T>. So the context is built untyped here and read back, validated, through
 * readAgentTenantContext.
 */
export function createAgentRequestContext(tenant: AgentTenantContext): RequestContext {
  const requestContext = new RequestContext();
  requestContext.set(AGENT_CONTEXT_KEYS.userId, tenant.userId);
  requestContext.set(AGENT_CONTEXT_KEYS.activeOrganizationId, tenant.activeOrganizationId);
  return requestContext;
}

/** Reads the tenant a tool runs for. Throws when the route did not provide one. */
export function readAgentTenantContext(
  requestContext: ContextReader | undefined,
): AgentTenantContext {
  const parsed = agentTenantContextSchema.safeParse({
    userId: requestContext?.get(AGENT_CONTEXT_KEYS.userId),
    activeOrganizationId: requestContext?.get(AGENT_CONTEXT_KEYS.activeOrganizationId),
  });
  if (!parsed.success) {
    throw new Error(
      'Agent request context has no tenant: userId and activeOrganizationId are required.',
    );
  }
  return parsed.data;
}

/** Memory is scoped per workspace and user: `<organizationId>:<userId>`. */
export function memoryResourceId(tenant: AgentTenantContext): string {
  return `${tenant.activeOrganizationId}:${tenant.userId}`;
}
