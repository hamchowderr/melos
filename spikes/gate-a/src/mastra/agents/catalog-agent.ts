import { createOpenAI } from "@ai-sdk/openai";
import { Agent } from "@mastra/core/agent";
import { Memory } from "@mastra/memory";
import { getComposition } from "../tools/get-composition";

// Spike safety: every model call goes to the local AIMock server with a dummy
// key, so a stray environment can never reach (or bill) a real provider.
const openai = createOpenAI({
  baseURL: `${(process.env.AIMOCK_URL ?? "http://127.0.0.1:4010").replace(/\/$/, "")}/v1`,
  apiKey: "aimock-no-real-key",
});

export const catalogAgent = new Agent({
  id: "catalog",
  name: "Catalog Agent",
  instructions:
    "You answer questions about the Melos music catalog. When the user names a composition, call getComposition with its title. Never invent rights data.",
  // .chat() forces /v1/chat/completions (the default provider call uses the Responses API).
  model: openai.chat("gpt-4o-mini"),
  tools: { getComposition },
  memory: new Memory({ options: { lastMessages: 10 } }),
});
