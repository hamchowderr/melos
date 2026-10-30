'use server';

import { resolveWorkspaceAction } from '@/app/workspace-action';
import type { ContactMethodInput, PartyInput, PartyMatch } from '@/lib/dto/contacts';
import { findMatchingParties, setContactMethods } from '@/server/services/contacts/methods';
import { createParty, deleteParty, updateParty } from '@/server/services/contacts/parties';
import type { ServiceResult } from '@/server/services/service-result';

/** A stored write with the party's id, or the refusal: its code and, when it has them, counts. */
export type PartyActionResult =
  | { ok: true; partyId: string }
  | { ok: false; code: string; counts?: Readonly<Record<string, number>> };

const outcome = (result: ServiceResult<{ partyId: string }>): PartyActionResult => {
  if (result.ok) return { ok: true, partyId: result.value.partyId };
  const { error } = result;
  return { ok: false, code: error.code, ...('counts' in error ? { counts: error.counts } : {}) };
};

/**
 * Creates a party, or updates `partyId`, for the tenant resolved from this request (§7.1), then
 * sets its methods when `methods` is given. ContactService checks the role (§6.2) and every field;
 * a database failure throws WorkspaceConnectionError, which carries no database message (§7.2).
 */
export async function saveParty(
  partyId: string | null,
  input: PartyInput,
  methods?: ContactMethodInput[],
): Promise<PartyActionResult> {
  const workspace = await resolveWorkspaceAction();
  if (workspace.status !== 'ready') return { ok: false, code: workspace.status };
  const { tenant } = workspace;
  const saved = partyId ? updateParty(tenant, partyId, input) : createParty(tenant, input);
  const party = await saved;
  if (!party.ok || !methods) return outcome(party);
  return outcome(await setContactMethods(tenant, party.value.partyId, methods));
}

/** Replaces a party's contact methods (§4.2) as the methods editor holds them. */
export async function saveContactMethods(
  partyId: string,
  methods: ContactMethodInput[],
): Promise<PartyActionResult> {
  const workspace = await resolveWorkspaceAction();
  if (workspace.status !== 'ready') return { ok: false, code: workspace.status };
  return outcome(await setContactMethods(workspace.tenant, partyId, methods));
}

/** Live parties with the same name or email, for the possible duplicate warning (§6.15). */
export async function checkDuplicates(query: {
  displayName?: string;
  email?: string;
}): Promise<PartyMatch[]> {
  const workspace = await resolveWorkspaceAction();
  if (workspace.status !== 'ready') return [];
  const found = await findMatchingParties(workspace.tenant, query);
  return found.ok ? found.value : [];
}

/** Soft-deletes a party; one still in use is REFERENCED with the counts that hold it. */
export async function removeParty(partyId: string): Promise<PartyActionResult> {
  const workspace = await resolveWorkspaceAction();
  if (workspace.status !== 'ready') return { ok: false, code: workspace.status };
  return outcome(await deleteParty(workspace.tenant, partyId));
}
