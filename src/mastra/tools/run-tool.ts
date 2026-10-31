import type { ToolResult } from '../../lib/agent/tool-result';
import type { ServiceResult } from '../../server/services/service-result';
import type { TenantContext } from '../../server/services/tenant-context';
import { readTenantContext } from '../request-context';

type ContextReader = { get(key: string): unknown };

/**
 * Runs one service call for the tenant the route resolved (§3.1, §7.1). A missing or invalid
 * tenant returns NO_TENANT before any service runs; tools hold no SQL and no authorization.
 */
export async function runTool<T>(
  context: { requestContext?: ContextReader } | undefined,
  call: (tenant: TenantContext) => Promise<ServiceResult<T>>,
): Promise<ToolResult<T>> {
  let tenant: TenantContext;
  try {
    tenant = readTenantContext(context?.requestContext);
  } catch {
    return { status: 'error', error: { code: 'NO_TENANT' } };
  }
  const result = await call(tenant);
  return result.ok
    ? { status: 'ok', value: result.value }
    : { status: 'error', error: { ...result.error } };
}

/**
 * `toModelOutput`: the compact, id-bearing §3.6 summary of a success, or the refusal as is. The
 * full DTO still reaches the UI through the tool result event.
 */
export const modelOutput =
  <T, M>(summarize: (value: T) => M) =>
  (result: ToolResult<T>) => ({
    type: 'json' as const,
    value: result.status === 'ok' ? summarize(result.value) : result,
  });
