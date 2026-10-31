import { z } from 'zod';

/**
 * What every Melos agent tool returns (docs/CONTRACT.md §3.1): the full DTO for the UI, or a
 * refusal code with its typed details, never a message. `NO_TENANT` means the route supplied no
 * valid tenant, so no service ran. Shared by the tools (server) and their renderers (browser).
 */
export type ToolError = { code: string } & Record<string, unknown>;
export type ToolResult<T> = { status: 'ok'; value: T } | { status: 'error'; error: ToolError };

/** The output schema of a tool returning `T`: the DTO is typed, not re-validated, here. */
export const toolResultSchema = <T>() =>
  z.union([
    z.object({ status: z.literal('ok'), value: z.custom<T>() }),
    z.object({ status: z.literal('error'), error: z.looseObject({ code: z.string() }) }),
  ]);
