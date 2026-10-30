'use server';

import { resolveWorkspaceAction } from '@/app/workspace-action';
import type { ReleaseInput } from '@/lib/dto/catalog';
import { createRelease } from '@/server/services/catalog/releases';

/** A stored release, or the refusal code and the field it names. */
export type ReleaseActionResult = { ok: true } | { ok: false; code: string; field?: string };

/**
 * Creates a release with its tracks (CAT-007) for the tenant resolved from this request (§7.1).
 * CatalogService checks the role (§6.2), every field and the UPC/EAN check digit (D-1).
 */
export async function saveNewRelease(input: ReleaseInput): Promise<ReleaseActionResult> {
  const workspace = await resolveWorkspaceAction();
  if (workspace.status !== 'ready') return { ok: false, code: workspace.status };
  const result = await createRelease(workspace.tenant, input);
  if (result.ok) return { ok: true };
  const { error } = result;
  return {
    ok: false,
    code: error.code,
    ...('field' in error ? { field: String(error.field) } : {}),
  };
}
