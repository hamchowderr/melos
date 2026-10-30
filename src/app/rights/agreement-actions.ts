'use server';

import { resolveWorkspaceAction } from '@/app/workspace-action';
import type { AgreementInput, AgreementType } from '@/lib/dto/rights';
import { createAgreement } from '@/server/services/rights/agreements';

/** A stored agreement, or the refusal code and the field it names. */
export type AgreementActionResult = { ok: true } | { ok: false; code: string; field?: string };

const FIELDS = ['agreementType', 'title', 'counterpartyPartyId', 'effectiveOn', 'expiresOn'];

/**
 * Records an agreement (RGT-006) for the tenant resolved from this request (§7.1). The input is
 * parsed first, since a server action takes any value: each field is a string, or null when
 * optional, else VALIDATION names it. createAgreement checks rights:update (D-5) and every rule.
 */
export async function saveNewAgreement(input: unknown): Promise<AgreementActionResult> {
  const fields = (typeof input === 'object' && input ? input : {}) as Record<string, unknown>;
  const wrong = FIELDS.find((field, i) => {
    const value = fields[field];
    return typeof value !== 'string' && !(i > 1 && (value === null || value === undefined));
  });
  if (wrong) return { ok: false, code: 'VALIDATION', field: wrong };
  const workspace = await resolveWorkspaceAction();
  if (workspace.status !== 'ready') return { ok: false, code: workspace.status };
  const text = (field: string) => (fields[field] as string | null | undefined) || null;
  const parsed: AgreementInput = {
    ...{ agreementType: fields.agreementType as AgreementType, title: fields.title as string },
    counterpartyPartyId: text('counterpartyPartyId'),
    ...{ effectiveOn: text('effectiveOn'), expiresOn: text('expiresOn') },
  };
  const result = await createAgreement(workspace.tenant, parsed);
  if (result.ok) return { ok: true };
  const { error } = result;
  return { ok: false, code: error.code, ...('field' in error ? { field: error.field } : {}) };
}
