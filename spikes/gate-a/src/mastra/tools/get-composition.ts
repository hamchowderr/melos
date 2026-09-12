import { createTool } from "@mastra/core/tools";
import {
  type Composition,
  compositionSchema,
  getCompositionInputSchema,
} from "../../lib/composition";

/** Keys the web app's AG-UI route writes into the Mastra RequestContext. */
export type CatalogRequestContext = {
  userId: string;
  organizationId: string | null;
};

export const getComposition = createTool({
  id: "getComposition",
  description:
    "Look up a composition in the catalog by title and return its rights record.",
  inputSchema: getCompositionInputSchema,
  outputSchema: compositionSchema,
  execute: async (_input, context): Promise<Composition> => {
    const userId = context?.requestContext?.get("userId") as string | undefined;
    const organizationId = context?.requestContext?.get("organizationId") as
      | string
      | null
      | undefined;
    // Hardcoded DTO: the spike proves the typed round trip, not catalog storage.
    return {
      id: "comp_midnight_drive",
      title: "Midnight Drive",
      iswc: "T-123.456.789-0",
      durationSec: 214,
      bpm: 92,
      key: "A minor",
      publisher: "Melos Music Publishing",
      writers: [
        { name: "Ava Reyes", role: "Composer", sharePct: 50 },
        { name: "Jon Park", role: "Lyricist", sharePct: 50 },
      ],
      context: {
        userId: userId ?? null,
        organizationId: organizationId ?? null,
      },
    };
  },
});
