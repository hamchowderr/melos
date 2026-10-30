'use server';

import { resolveWorkspaceAction } from '@/app/workspace-action';
import type { CompositionDuplicate, CompositionPatch, SongInput } from '@/lib/dto/catalog';
import {
  findCompositionDuplicates,
  updateComposition,
} from '@/server/services/catalog/compositions';
import { createSong, deleteSong } from '@/server/services/catalog/songs';
import type { ServiceError, ServiceResult } from '@/server/services/service-result';

/**
 * A stored song write with the composition's id, or the refusal: its code, the field it names and,
 * for REFERENCED, the counts that hold the song.
 */
export type SongActionResult =
  | { ok: true; compositionId: string }
  | { ok: false; code: string; field?: string; counts?: Readonly<Record<string, number>> };

const refusal = (error: ServiceError): SongActionResult => ({
  ok: false,
  code: error.code,
  ...('field' in error ? { field: error.field } : {}),
  ...('counts' in error ? { counts: error.counts } : {}),
});

const outcome = <T>(result: ServiceResult<T>, compositionId: (value: T) => string) =>
  result.ok
    ? { ok: true as const, compositionId: compositionId(result.value) }
    : refusal(result.error);

/**
 * Creates a song (D-10) for the tenant resolved from this request (§7.1). CatalogService checks the
 * role (§6.2) and every field; a database failure throws WorkspaceConnectionError, which carries no
 * database message (§7.2).
 */
export async function saveNewSong(input: SongInput): Promise<SongActionResult> {
  const workspace = await resolveWorkspaceAction();
  if (workspace.status !== 'ready') return { ok: false, code: workspace.status };
  return outcome(await createSong(workspace.tenant, input), (song) => song.composition?.id ?? '');
}

/** Applies a composition patch from the song form (CAT-001, CAT-004). */
export async function saveSong(
  compositionId: string,
  patch: CompositionPatch,
): Promise<SongActionResult> {
  const workspace = await resolveWorkspaceAction();
  if (workspace.status !== 'ready') return { ok: false, code: workspace.status };
  return outcome(
    await updateComposition(workspace.tenant, compositionId, patch),
    () => compositionId,
  );
}

/** Soft-deletes a song and its recordings; one still in use is REFERENCED with its counts. */
export async function removeSong(compositionId: string): Promise<SongActionResult> {
  const workspace = await resolveWorkspaceAction();
  if (workspace.status !== 'ready') return { ok: false, code: workspace.status };
  return outcome(await deleteSong(workspace.tenant, compositionId), () => compositionId);
}

/** Live songs with the same title or ISWC, for the duplicate warning on create (§6.15). */
export async function checkSongDuplicates(query: {
  title: string;
  iswc?: string | null;
}): Promise<CompositionDuplicate[]> {
  const workspace = await resolveWorkspaceAction();
  if (workspace.status !== 'ready') return [];
  const found = await findCompositionDuplicates(workspace.tenant, query);
  return found.ok ? found.value : [];
}
