'use server';

import { resolveWorkspaceAction } from '@/app/workspace-action';
import type { UploadTicketDTO } from '@/lib/dto/assets';
import {
  addAsset,
  completeUpload,
  createUpload,
  getDownloadUrl,
} from '@/server/services/assets/asset-service';

type Refused = { ok: false; code: string };

/**
 * Starts an audio upload (§7.5) for the tenant resolved from this request (§7.1): AssetService
 * generates the key and signs a PUT. catalog:update.
 */
export async function startAudioUpload(
  fileName: string,
  contentType: string,
): Promise<{ ok: true; ticket: UploadTicketDTO } | Refused> {
  const workspace = await resolveWorkspaceAction();
  if (workspace.status !== 'ready') return { ok: false, code: workspace.status };
  const result = await createUpload(workspace.tenant, {
    assetType: 'audio',
    fileName,
    contentType,
  });
  return result.ok ? { ok: true, ticket: result.value } : { ok: false, code: result.error.code };
}

/** Registers the uploaded file and attaches it to the recording as its master audio (CAT-005). */
export async function finishAudioUpload(
  recordingId: string,
  assetId: string,
  fileName: string,
): Promise<{ ok: true } | Refused> {
  const workspace = await resolveWorkspaceAction();
  if (workspace.status !== 'ready') return { ok: false, code: workspace.status };
  const { tenant } = workspace;
  const asset = await completeUpload(tenant, { assetId, assetType: 'audio', fileName });
  if (!asset.ok) return { ok: false, code: asset.error.code };
  const target = { recordingId };
  const link = await addAsset(tenant, { assetId, target, relationship: 'audio_master' });
  return link.ok ? { ok: true } : { ok: false, code: link.error.code };
}

/** A fresh signed URL for an audio asset (P-35), for AudioPlayer's one re-sign. catalog:read. */
export async function signAudio(assetId: string): Promise<string | null> {
  const workspace = await resolveWorkspaceAction();
  if (workspace.status !== 'ready') return null;
  const result = await getDownloadUrl(workspace.tenant, assetId);
  return result.ok ? result.value.url : null;
}
