'use server';

import { resolveWorkspaceAction } from '@/app/workspace-action';
import type { RecordingDuplicate, RecordingInput, RecordingPatch } from '@/lib/dto/catalog';
import {
  createRecording,
  findRecordingDuplicates,
  updateRecording,
} from '@/server/services/catalog/recordings';
import type { ServiceResult } from '@/server/services/service-result';

/** A stored recording write, or the refusal code and the field it names. */
export type RecordingActionResult = { ok: true } | { ok: false; code: string; field?: string };

const outcome = (result: ServiceResult<unknown>): RecordingActionResult =>
  result.ok
    ? { ok: true }
    : {
        ok: false,
        code: result.error.code,
        ...('field' in result.error ? { field: String(result.error.field) } : {}),
      };

/**
 * Adds a recording to a song (CAT-002) for the tenant resolved from this request (§7.1).
 * CatalogService checks the role (§6.2) and every field.
 */
export async function saveNewRecording(input: RecordingInput): Promise<RecordingActionResult> {
  const workspace = await resolveWorkspaceAction();
  if (workspace.status !== 'ready') return { ok: false, code: workspace.status };
  return outcome(await createRecording(workspace.tenant, input));
}

/** Applies a recording patch from the recording form (CAT-002, CAT-004, CAT-005). */
export async function saveRecording(
  recordingId: string,
  patch: RecordingPatch,
): Promise<RecordingActionResult> {
  const workspace = await resolveWorkspaceAction();
  if (workspace.status !== 'ready') return { ok: false, code: workspace.status };
  return outcome(await updateRecording(workspace.tenant, recordingId, patch));
}

/** Live recordings with the same ISRC, or title and version, for the warning on add (§6.15). */
export async function checkRecordingDuplicates(
  query: Pick<RecordingInput, 'compositionId' | 'title' | 'versionTitle' | 'isrc'>,
): Promise<RecordingDuplicate[]> {
  const workspace = await resolveWorkspaceAction();
  if (workspace.status !== 'ready') return [];
  const found = await findRecordingDuplicates(workspace.tenant, query);
  return found.ok ? found.value : [];
}
