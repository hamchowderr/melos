import { rmSync } from "node:fs";
import { LLMock } from "@copilotkit/aimock";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const BASE = "http://localhost:3100";
type Handler = (request: Request) => Promise<Response> | Response;

let mock: LLMock;
let authRoute: { GET: Handler; POST: Handler };
let copilotRoute: { GET: Handler; POST: Handler };
let serverAuth: typeof import("../src/lib/auth").auth;

beforeAll(async () => {
  mock = new LLMock({ port: 0 });
  mock.loadFixtureFile("fixtures/midnight-drive.json");
  process.env.AIMOCK_URL = await mock.start();

  rmSync("data/test-auth.db", { force: true });
  rmSync("data/test-context-mastra.db", { force: true });
  process.env.AUTH_DATABASE_URL = "file:./data/test-auth.db";
  process.env.MASTRA_DATABASE_URL = "file:./data/test-context-mastra.db";
  process.env.BETTER_AUTH_URL = BASE;

  const { drizzle } = await import("drizzle-orm/libsql");
  const { migrate } = await import("drizzle-orm/libsql/migrator");
  const { authClient } = await import("../src/lib/db");
  await migrate(drizzle(authClient), { migrationsFolder: "./drizzle" });

  authRoute = await import("../src/app/api/auth/[...all]/route");
  copilotRoute = await import("../src/app/api/copilotkit/[[...slug]]/route");
  ({ auth: serverAuth } = await import("../src/lib/auth"));
});

afterAll(async () => {
  await mock?.stop();
});

let cookie = "";

async function call(handler: Handler, method: string, path: string, body?: unknown) {
  const response = await handler(
    new Request(`${BASE}${path}`, {
      method,
      headers: {
        origin: BASE,
        "content-type": "application/json",
        ...(cookie ? { cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  const setCookies = response.headers.getSetCookie();
  if (setCookies.length > 0) {
    const jar = new Map(cookie.split("; ").filter(Boolean).map((c) => c.split(/=(.*)/s).slice(0, 2) as [string, string]));
    for (const sc of setCookies) {
      const [pair] = sc.split(";");
      const [name, value] = pair.split(/=(.*)/s);
      jar.set(name, value);
    }
    cookie = [...jar].map(([n, v]) => `${n}=${v}`).join("; ");
  }
  return response;
}

describe("Better Auth (organization) -> AG-UI route -> Mastra tool request context", () => {
  const email = `gate-a-${Date.now()}@example.test`;
  const password = "gate-a-password-123";
  let organizationId = "";

  it("signs up and signs in", async () => {
    const signUp = await call(authRoute.POST, "POST", "/api/auth/sign-up/email", { email, password, name: "Gate A" });
    expect(signUp.status).toBe(200);
    cookie = "";
    const signIn = await call(authRoute.POST, "POST", "/api/auth/sign-in/email", { email, password });
    expect(signIn.status).toBe(200);
    expect(cookie).toContain("session_token");
  });

  it("creates an organization and sets it active", async () => {
    const created = await call(authRoute.POST, "POST", "/api/auth/organization/create", {
      name: "Midnight Records",
      slug: `midnight-records-${Date.now()}`,
    });
    expect(created.status).toBe(200);
    organizationId = ((await created.json()) as { id: string }).id;
    expect(organizationId).toBeTruthy();

    const active = await call(authRoute.POST, "POST", "/api/auth/organization/set-active", { organizationId });
    expect(active.status).toBe(200);
  });

  it("reads the session server-side with the active organization", async () => {
    const session = await serverAuth.api.getSession({ headers: new Headers({ cookie }) });
    expect(session?.user.email).toBe(email);
    expect(session?.session.activeOrganizationId).toBe(organizationId);
  });

  it("rejects the AG-UI route without a session", async () => {
    const saved = cookie;
    cookie = "";
    const response = await call(copilotRoute.GET, "GET", "/api/copilotkit/info");
    cookie = saved;
    expect(response.status).toBe(401);
  });

  it("runs the agent over AG-UI and the tool sees the session's active org", async () => {
    const response = await call(copilotRoute.POST, "POST", "/api/copilotkit/agent/catalog/run", {
      threadId: `thread-${Date.now()}`,
      runId: `run-${Date.now()}`,
      messages: [{ id: "msg-1", role: "user", content: "Show me Midnight Drive" }],
      tools: [],
      context: [],
      state: {},
      forwardedProps: {},
    });
    expect(response.status).toBe(200);
    const events = (await response.text())
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => JSON.parse(line.slice(5).trim()) as { type: string; content?: string; toolCallName?: string });

    const types = events.map((e) => e.type);
    expect(types).toContain("TOOL_CALL_START");
    const toolResult = events.find((e) => e.type === "TOOL_CALL_RESULT");
    expect(toolResult?.content).toBeTruthy();
    const composition = JSON.parse(toolResult?.content ?? "{}") as {
      title: string;
      context: { organizationId: string | null; userId: string | null };
    };
    expect(composition.title).toBe("Midnight Drive");
    expect(composition.context.organizationId).toBe(organizationId);
    expect(composition.context.userId).toBeTruthy();
    expect(types).toContain("RUN_FINISHED");
  });
});
