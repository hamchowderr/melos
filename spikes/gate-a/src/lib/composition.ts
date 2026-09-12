import { z } from "zod";

// The typed DTO shared by the Mastra tool (outputSchema) and the React card.
export const compositionSchema = z.object({
  id: z.string(),
  title: z.string(),
  iswc: z.string(),
  durationSec: z.number(),
  bpm: z.number(),
  key: z.string(),
  publisher: z.string(),
  writers: z.array(
    z.object({ name: z.string(), role: z.string(), sharePct: z.number() }),
  ),
  // Echo of the Mastra request context the tool ran with (auth -> agent proof).
  context: z.object({
    userId: z.string().nullable(),
    organizationId: z.string().nullable(),
  }),
});

export type Composition = z.infer<typeof compositionSchema>;

export const getCompositionInputSchema = z.object({
  title: z.string().describe("Composition title to look up"),
});
