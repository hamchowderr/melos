'use server';

import { resolveWorkspaceAction } from '@/app/workspace-action';
import type { LicensingContactsInput, RepresentationInput } from '@/lib/dto/rights';
import {
  attestRepresentation,
  updateLicensingContacts,
} from '@/server/services/rights/representation';
import type { ServiceResult } from '@/server/services/service-result';

/** A stored representation or contact change, or the refusal code. */
export type LicensingResult = { ok: true } | { ok: false; code: string };

const outcome = (result: ServiceResult<unknown>): LicensingResult =>
  result.ok ? { ok: true } : { ok: false, code: result.error.code };

/**
 * Sets or clears the attestation that the workspace represents another holder's interest (RGT-005)
 * for the tenant resolved from this request (§7.1). attestRepresentation checks rights:update.
 */
export async function saveRepresentation(input: RepresentationInput): Promise<LicensingResult> {
  const workspace = await resolveWorkspaceAction();
  if (workspace.status !== 'ready') return { ok: false, code: workspace.status };
  return outcome(await attestRepresentation(workspace.tenant, input));
}

/** Replaces a song's or recording's licensing contacts (RGT-005); the service checks each one. */
export async function saveLicensingContacts(
  input: LicensingContactsInput,
): Promise<LicensingResult> {
  const workspace = await resolveWorkspaceAction();
  if (workspace.status !== 'ready') return { ok: false, code: workspace.status };
  return outcome(await updateLicensingContacts(workspace.tenant, input));
}
