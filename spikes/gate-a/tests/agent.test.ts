import { rmSync } from "node:fs";
import { LLMock } from "@copilotkit/aimock";
import { RequestContext } from "@mastra/core/request-context";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Mastra } from "@mastra/core/mastra";

let mock: LLMock;
let mastra: Mastra;

beforeAll(async () => {
  mock = new LLMock({ port: 0 });
  mock.loadFixtureFile("fixtures/midnight-drive.json");
  process.env.AIMOCK_URL = await mock.start();
  rmSync("data/test-agent-mastra.db", { force: true });
  process.env.MASTRA_DATABASE_URL = "file:./data/test-agent-mastra.db";
  // Import after the env is set: the model client reads AIMOCK_URL at construction.
  ({ mastra } = await import("../src/mastra"));
});

afterAll(async () => {
  await mock?.stop();
});

type ToolResultLike = { toolName?: string; result?: unknown; payload?: { toolName?: string; result?: unknown } };

describe("catalog agent through AIMock", () => {
  it("calls getComposition and returns the typed DTO with request context", async () => {
    const requestContext = new RequestContext();
    requestContext.set("userId", "user_test");
    requestContext.set("organizationId", "org_test");

    const result = await mastra.getAgent("catalog").generate("Show me Midnight Drive", {
      requestContext,
      memory: { thread: `thread-${Date.now()}`, resource: "user_test" },
    });

    const toolResults = (result.toolResults as ToolResultLike[]).map((r) => r.payload ?? r);
    const composition = toolResults.find((r) => r.toolName === "getComposition")?.result as
      | { title: string; writers: unknown[]; context: { organizationId: string | null } }
      | undefined;

    expect(composition?.title).toBe("Midnight Drive");
    expect(composition?.writers).toHaveLength(2);
    expect(composition?.context.organizationId).toBe("org_test");
    expect(result.text).toBe("Here is the catalog record for Midnight Drive.");
    // Both model turns (tool call, then final text) were served by AIMock.
    expect(mock.getRequests().length).toBeGreaterThanOrEqual(2);
  });
});
