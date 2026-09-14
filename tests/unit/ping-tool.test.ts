import { RequestContext } from '@mastra/core/request-context';
import { describe, expect, it, vi } from 'vitest';
import { createAgentRequestContext } from '../../src/mastra/request-context';
import { pingTool } from '../../src/mastra/tools/ping';

const checkWorkspaceDatabase = vi.hoisted(() => vi.fn(async (_workspaceId: string) => {}));
vi.mock('../../src/server/services/workspace-connections', () => ({ checkWorkspaceDatabase }));

type Execute = (input: object, context: { requestContext: RequestContext }) => Promise<unknown>;
const execute = pingTool.execute as unknown as Execute;

describe('ping tool', () => {
  it('reads the workspace database and returns the workspace, user and role from the request context', async () => {
    const requestContext = createAgentRequestContext({
      userId: 'user_1',
      organizationId: 'org_1',
      workspaceId: 'ws_1',
      workspaceRole: 'member',
      requestId: 'req_1',
    });
    await expect(execute({}, { requestContext })).resolves.toEqual({
      status: 'ok',
      organizationId: 'org_1',
      workspaceId: 'ws_1',
      userId: 'user_1',
      workspaceRole: 'member',
    });
    expect(checkWorkspaceDatabase).toHaveBeenCalledExactlyOnceWith('ws_1');
  });

  it('fails closed when the route supplied no tenant', async () => {
    checkWorkspaceDatabase.mockClear();
    await expect(execute({}, { requestContext: new RequestContext() })).rejects.toThrow(
      /no tenant/,
    );
    expect(checkWorkspaceDatabase).not.toHaveBeenCalled();
  });
});
