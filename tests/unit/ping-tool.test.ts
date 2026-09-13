import { RequestContext } from '@mastra/core/request-context';
import { describe, expect, it } from 'vitest';
import { createAgentRequestContext } from '../../src/mastra/request-context';
import { pingTool } from '../../src/mastra/tools/ping';

type Execute = (input: object, context: { requestContext: RequestContext }) => Promise<unknown>;
const execute = pingTool.execute as unknown as Execute;

describe('ping tool', () => {
  it('returns the workspace, user and role from the request context', async () => {
    const requestContext = createAgentRequestContext({
      userId: 'user_1',
      organizationId: 'org_1',
      workspaceRole: 'member',
      requestId: 'req_1',
    });
    await expect(execute({}, { requestContext })).resolves.toEqual({
      status: 'ok',
      organizationId: 'org_1',
      userId: 'user_1',
      workspaceRole: 'member',
    });
  });

  it('fails closed when the route supplied no tenant', async () => {
    await expect(execute({}, { requestContext: new RequestContext() })).rejects.toThrow(
      /no tenant/,
    );
  });
});
