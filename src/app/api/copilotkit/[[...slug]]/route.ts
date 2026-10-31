import { MastraAgent } from '@ag-ui/mastra';
import { CopilotRuntime, createCopilotRuntimeHandler } from '@copilotkit/runtime/v2';
import { mastra } from '@/mastra';
import { createAgentRequestContext, memoryResourceId } from '@/mastra/request-context';
import { MelosAgentRunner } from '@/server/agent/melos-agent-runner';
import { allowServedRoutesOnly } from '@/server/agent/route-guard';
import { tenantContextResolver } from '@/server/services/tenant-context';

export const dynamic = 'force-dynamic';
// The Fluid compute default on every plan; a run still going then is cut (§7.9, P-32).
export const maxDuration = 300;

/**
 * CopilotKit v2 (GET /info, POST /agent/:id/run, ...) -> AG-UI -> embedded Mastra agents.
 * The tenant comes from the session, member row and workspace registry on every request, never
 * from the browser. Agents are built per request: MastraAgent keeps requestContext and
 * resourceId on the instance (§7.1 step 4).
 */
async function handle(request: Request): Promise<Response> {
  const tenant = await tenantContextResolver.resolve(request.headers);
  // 401 without a valid session, 403 for every other failure (a workspace that is missing from
  // the registry or not active included); no agent is built or run.
  if (tenant.status !== 'ok') {
    const status = tenant.status === 'unauthenticated' ? 401 : 403;
    return Response.json({ error: tenant.status }, { status });
  }

  const resourceId = memoryResourceId(tenant.context);
  const runtime = new CopilotRuntime({
    agents: MastraAgent.getLocalAgents({
      mastra,
      resourceId,
      requestContext: createAgentRequestContext(tenant.context),
    }),
    // Thread ownership and persisted history (§7.9, TEN-009, TEN-010), never the in-memory runner.
    runner: new MelosAgentRunner({ resourceId, workspaceId: tenant.context.workspaceId }),
  });
  const handler = createCopilotRuntimeHandler({
    runtime,
    basePath: '/api/copilotkit',
    hooks: { onBeforeHandler: allowServedRoutesOnly },
  });
  return handler(request);
}

export const GET = handle;
export const POST = handle;
