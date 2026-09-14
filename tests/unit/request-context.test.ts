import { RequestContext } from '@mastra/core/request-context';
import { describe, expect, it } from 'vitest';
import {
  createAgentRequestContext,
  memoryResourceId,
  readTenantContext,
} from '../../src/mastra/request-context';

describe('agent request context', () => {
  const tenant = {
    userId: 'user_1',
    organizationId: 'org_1',
    workspaceId: 'ws_1',
    workspaceRole: 'viewer',
    requestId: 'req_1',
  } as const;

  it('round-trips the tenant through a Mastra RequestContext', () => {
    expect(readTenantContext(createAgentRequestContext(tenant))).toEqual(tenant);
  });

  it('refuses a context without a tenant', () => {
    expect(() => readTenantContext(new RequestContext())).toThrow(/no tenant/);
    expect(() => readTenantContext(undefined)).toThrow(/no tenant/);
  });

  it('refuses a context without workspaceId', () => {
    const requestContext = new RequestContext();
    for (const [key, value] of Object.entries(tenant)) {
      if (key !== 'workspaceId') requestContext.set(key, value);
    }
    expect(() => readTenantContext(requestContext)).toThrow(/no tenant: .*workspaceId/);
  });

  it('refuses a context whose role is not one Melos role', () => {
    const requestContext = createAgentRequestContext(tenant);
    requestContext.set('workspaceRole', 'member,viewer');
    expect(() => readTenantContext(requestContext)).toThrow(/no tenant/);
  });

  it('scopes memory to the workspace and the user', () => {
    expect(memoryResourceId(tenant)).toBe('org_1:user_1');
  });
});
