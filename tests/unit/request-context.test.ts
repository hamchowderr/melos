import { RequestContext } from '@mastra/core/request-context';
import { describe, expect, it } from 'vitest';
import {
  createAgentRequestContext,
  memoryResourceId,
  readAgentTenantContext,
} from '../../src/mastra/request-context';

describe('agent request context', () => {
  const tenant = { userId: 'user_1', activeOrganizationId: 'org_1' };

  it('round-trips the tenant through a Mastra RequestContext', () => {
    expect(readAgentTenantContext(createAgentRequestContext(tenant))).toEqual(tenant);
  });

  it('refuses a context without a tenant', () => {
    expect(() => readAgentTenantContext(new RequestContext())).toThrow(/no tenant/);
    expect(() => readAgentTenantContext(undefined)).toThrow(/no tenant/);
  });

  it('scopes memory to the workspace and the user', () => {
    expect(memoryResourceId(tenant)).toBe('org_1:user_1');
  });
});
