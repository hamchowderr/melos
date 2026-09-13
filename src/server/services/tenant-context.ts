import { auth } from '../auth/auth';

export type TenantContext = {
  userId: string;
  activeOrganizationId: string;
};

export type TenantResolution =
  | { status: 'ok'; context: TenantContext }
  | { status: 'unauthenticated' }
  | { status: 'no-active-workspace' };

/** Derives who is calling and which workspace they act in. Never trusts client input. */
export interface TenantContextResolver {
  resolve(headers: Headers): Promise<TenantResolution>;
}

/**
 * Placeholder resolver: reads the Better Auth session only. Membership and role checks,
 * and routing to a tenant database, belong here once the domain contract lands.
 * A null active workspace is never defaulted to another workspace.
 */
export const sessionTenantContextResolver: TenantContextResolver = {
  async resolve(headers) {
    const session = await auth.api.getSession({ headers });
    if (!session) return { status: 'unauthenticated' };

    const activeOrganizationId = session.session.activeOrganizationId;
    if (!activeOrganizationId) return { status: 'no-active-workspace' };

    return {
      status: 'ok',
      context: { userId: session.user.id, activeOrganizationId },
    };
  },
};
