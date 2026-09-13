import { MastraAgent } from '@ag-ui/mastra';
import { CopilotRuntime, createCopilotRuntimeHandler } from '@copilotkit/runtime/v2';
import { mastra } from '@/mastra';
import { createAgentRequestContext, memoryResourceId } from '@/mastra/request-context';
import { sessionTenantContextResolver } from '@/server/services/tenant-context';

export const dynamic = 'force-dynamic';

/**
 * CopilotKit v2 (GET /info, POST /agent/:id/run, ...) -> AG-UI -> embedded Mastra agents.
 * The tenant comes from the server-side session on every request, never from the browser.
 */
async function handle(request: Request): Promise<Response> {
  const tenant = await sessionTenantContextResolver.resolve(request.headers);
  if (tenant.status === 'unauthenticated') {
    return Response.json({ error: 'unauthenticated' }, { status: 401 });
  }
  if (tenant.status === 'no-active-workspace') {
    return Response.json({ error: 'no_active_workspace' }, { status: 403 });
  }

  const runtime = new CopilotRuntime({
    agents: MastraAgent.getLocalAgents({
      mastra,
      resourceId: memoryResourceId(tenant.context),
      requestContext: createAgentRequestContext(tenant.context),
    }),
  });
  const handler = createCopilotRuntimeHandler({
    runtime,
    basePath: '/api/copilotkit',
  });
  return handler(request);
}

export const GET = handle;
export const POST = handle;
