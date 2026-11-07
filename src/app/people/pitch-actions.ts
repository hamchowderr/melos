'use server';

import { resolveWorkspaceAction } from '@/app/workspace-action';
import type { CreatePitchInput } from '@/lib/dto/pitches';
import { createPitch } from '@/server/services/pitches/write';

/** createPitch from a contact's page (§2.3 ContactCard, CRM-002); PitchService checks pitch:create. */
export async function createContactPitch(
  input: CreatePitchInput,
): Promise<{ ok: true; pitchId: string } | { ok: false; code: string }> {
  const workspace = await resolveWorkspaceAction();
  if (workspace.status !== 'ready') return { ok: false, code: 'NO_TENANT' };
  const result = await createPitch(workspace.tenant, input);
  return result.ok
    ? { ok: true, pitchId: result.value.pitchId }
    : { ok: false, code: result.error.code };
}
