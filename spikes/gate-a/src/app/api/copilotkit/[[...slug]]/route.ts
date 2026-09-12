import { MastraAgent } from "@ag-ui/mastra";
import {
  CopilotRuntime,
  createCopilotRuntimeHandler,
} from "@copilotkit/runtime/v2";
import { RequestContext } from "@mastra/core/request-context";
import { auth } from "@/lib/auth";
import type { CatalogRequestContext } from "@/mastra/tools/get-composition";
import { mastra } from "@/mastra";

export const dynamic = "force-dynamic";

/**
 * CopilotKit (v2 multi-route: GET /info, POST /agent/:id/run, ...) -> AG-UI ->
 * local Mastra agents. The Better Auth session is read server-side per request
 * and written into the Mastra RequestContext, so tools see the caller's user
 * and active organization without trusting anything the browser sends.
 */
async function handle(request: Request): Promise<Response> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return Response.json({ error: "unauthenticated" }, { status: 401 });
  }

  // Untyped on purpose: @ag-ui/mastra 1.1.3 types getLocalAgents' requestContext
  // as RequestContext<unknown>, which rejects RequestContext<CatalogRequestContext>.
  const values: CatalogRequestContext = {
    userId: session.user.id,
    organizationId: session.session.activeOrganizationId ?? null,
  };
  const requestContext = new RequestContext();
  for (const [key, value] of Object.entries(values)) {
    requestContext.set(key, value);
  }

  const copilotRuntime = new CopilotRuntime({
    agents: MastraAgent.getLocalAgents({
      mastra,
      resourceId: session.user.id,
      requestContext,
    }),
  });
  const handler = createCopilotRuntimeHandler({
    runtime: copilotRuntime,
    basePath: "/api/copilotkit",
  });
  return handler(request);
}

export const GET = handle;
export const POST = handle;
