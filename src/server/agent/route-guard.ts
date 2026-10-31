import type { HandlerHookContext } from '@copilotkit/runtime/v2';

/**
 * The only CopilotKit routes Melos serves (docs/CONTRACT.md §7.9, TEN-012, ADR-027). Every other
 * route answers 404 before its handler runs: `agent/suggest` runs the agent without
 * `runtime.runner`, so no thread-ownership check would apply, and `threads/*` and `memories/*`
 * would list or change other callers' state.
 */
export const SERVED_COPILOT_ROUTES = ['info', 'agent/run', 'agent/connect', 'agent/stop'] as const;

const served: ReadonlySet<string> = new Set(SERVED_COPILOT_ROUTES);

/** `hooks.onBeforeHandler`: a thrown Response short-circuits the handler. */
export function allowServedRoutesOnly({ route }: Pick<HandlerHookContext, 'route'>): void {
  if (!served.has(route.method)) {
    throw Response.json({ error: 'Not found' }, { status: 404 });
  }
}
