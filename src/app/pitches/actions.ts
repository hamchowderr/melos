'use server';

import { resolveWorkspaceAction } from '@/app/workspace-action';
import type { PitchDTO, PitchNoteInput, TransitionInput } from '@/lib/dto/pitches';
import { getPitch } from '@/server/services/pitches/read';
import { addPitchNote, transitionPitchStatus } from '@/server/services/pitches/status';
import type { ServiceResult } from '@/server/services/service-result';

/** A pitch for the side panel, or the refusal code. */
export type PitchActionResult = { ok: true; pitch: PitchDTO } | { ok: false; code: string };

const outcome = (result: ServiceResult<PitchDTO>): PitchActionResult =>
  result.ok ? { ok: true, pitch: result.value } : { ok: false, code: result.error.code };

async function tenant() {
  const workspace = await resolveWorkspaceAction();
  return workspace.status === 'ready' ? workspace.tenant : null;
}

/** One pitch with its timeline (CRM-002); PitchService checks pitch:read. */
export async function loadPitch(pitchId: string): Promise<PitchActionResult> {
  const member = await tenant();
  return member ? outcome(await getPitch(member, pitchId)) : { ok: false, code: 'NO_TENANT' };
}

/** Moves one cell along the §6.4 table (CRM-004); pitch:update. */
export async function changePitchStatus(input: TransitionInput): Promise<PitchActionResult> {
  const member = await tenant();
  return member
    ? outcome(await transitionPitchStatus(member, input))
    : { ok: false, code: 'NO_TENANT' };
}

/** Adds a note to a pitch or one of its cells (CRM-004); pitch:update. */
export async function notePitch(input: PitchNoteInput): Promise<PitchActionResult> {
  const member = await tenant();
  return member ? outcome(await addPitchNote(member, input)) : { ok: false, code: 'NO_TENANT' };
}
