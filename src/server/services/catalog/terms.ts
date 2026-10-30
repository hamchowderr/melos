import { and, eq } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { WorkspacePermissions } from '../../../lib/auth/permissions';
import { type MetadataTermDTO, TERM_TYPES, type TermInput } from '../../../lib/dto/catalog';
import { metadataTerms as terms } from '../../db/schema/workspace.generated';
import { workspaceIntegrityGuard as guard } from '../integrity-guard';
import { requirePermission } from '../permissions';
import { failure, type ServiceResult, success } from '../service-result';
import type { TenantContext } from '../tenant-context';
import { runWorkspaceWrite } from '../workspace-write';

const UPDATE: WorkspacePermissions = { catalog: ['update'] };

const refuse = (reason: string) => failure({ code: 'VALIDATION', field: 'terms', reason });

/** A label as shown: trimmed, inner whitespace collapsed. */
const labelOf = (label: string) => label.trim().replace(/\s+/g, ' ');

/**
 * Finds or creates each term by type and normalized label (CAT-006, G-4: lowercase, trimmed), so
 * "Synth Pop" and " synth pop " resolve to one term; a new term keeps the label as first written.
 * catalog:update (§6.2) and VALIDATION come first, before the database opens. Each new term is
 * audited as metadata_term.create (D-4); a term that exists writes nothing. Returns the terms in
 * input order, without repeats, for a recording patch's `termIds`.
 */
export async function ensureTerms(
  tenant: TenantContext,
  input: TermInput[],
): Promise<ServiceResult<MetadataTermDTO[]>> {
  if (!requirePermission(tenant, UPDATE).ok) return failure('FORBIDDEN');
  if (input.some(({ termType }) => !TERM_TYPES.includes(termType)))
    return refuse('unknown_term_type');
  if (input.some(({ label }) => !label?.trim())) return refuse('required');
  return runWorkspaceWrite(tenant, UPDATE, async (tx, audit) => {
    const found = new Map<string, MetadataTermDTO>();
    for (const { termType, label } of input) {
      const shown = labelOf(label);
      const normalizedLabel = shown.toLowerCase();
      const key = `${termType}|${normalizedLabel}`;
      if (found.has(key)) continue;
      const same = and(eq(terms.termType, termType), eq(terms.normalizedLabel, normalizedLabel));
      const { id, label: held } = terms;
      const [existing] = await tx
        .select({ id, termType: terms.termType, label: held })
        .from(terms)
        .where(same);
      if (existing) {
        found.set(key, existing);
        continue;
      }
      const row = { id: `trm_${ulid()}`, termType, label: shown, normalizedLabel };
      await guard.insert(tx, terms, [row]);
      await audit.write({
        ...{ action: 'metadata_term.create', entityType: 'metadata_term', entityId: row.id },
        ...{ before: null, after: row },
      });
      found.set(key, { id: row.id, termType, label: shown });
    }
    return success([...found.values()]);
  });
}
