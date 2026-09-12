import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Mastra } from "@mastra/core/mastra";
import { LibSQLStore } from "@mastra/libsql";
import { catalogAgent } from "./agents/catalog-agent";

const storageUrl = process.env.MASTRA_DATABASE_URL ?? "file:./data/mastra.db";
if (storageUrl.startsWith("file:")) {
  mkdirSync(dirname(storageUrl.slice("file:".length)), { recursive: true });
}

export const mastra = new Mastra({
  agents: { catalog: catalogAgent },
  storage: new LibSQLStore({ id: "melos-spike-storage", url: storageUrl }),
});
