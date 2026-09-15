import { and, asc, eq, sql } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { WorkspacePermissions } from '../../../lib/auth/permissions';
import {
  AGREEMENT_TYPES,
  type AgreementDTO,
  type AgreementFilter,
  type AgreementInput,
  type AgreementPatch,
  type AgreementType,
} from '../../../lib/dto/rights';
import { agreements, parties } from '../../db/schema/workspace.generated';
import { workspaceIntegrityGuard as guard } from '../integrity-guard';
import { requirePermission } from '../permissions';
import { failure, type ServiceResult, success } from '../service-result';
import type { TenantContext } from '../tenant-context';
import { getWorkspaceDatabase, sanitized } from '../workspace-connections';
import { runWorkspaceWrite, type WorkspaceTransaction } from '../workspace-write';

/** Agreements are written with rights:update (§6.2, D-5). */
const WRITE: WorkspacePermissions = { rights: ['update'] };

const refuse = (field: string, reason: string) => failure({ code: 'VALIDATION', field, reason });

/** A real calendar date written `YYYY-MM-DD` (§1.4). */
export function isCalendarDate(value: string) {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(date.getTime())) return false;
  return date.toISOString().startsWith(value);
}

/** True when both dates are set and the agreement would expire before it takes effect. */
const reversed = (effectiveOn?: string | null, expiresOn?: string | null) =>
  Boolean(effectiveOn && expiresOn && expiresOn < effectiveOn);

/**
 * VALIDATION for the first field that breaks a rule, checked before the database opens: a type the
 * §4.3 CHECK allows, a title that is not blank, calendar dates, and `expiresOn` not before
 * `effectiveOn` when both are given. `complete` (a create) checks the required fields when omitted.
 */
function invalid(fields: AgreementPatch, complete: boolean): ServiceResult<never> | null {
  const given = (field: keyof AgreementPatch) => complete || fields[field] !== undefined;
  if (given('agreementType') && !AGREEMENT_TYPES.includes(fields.agreementType as AgreementType))
    return refuse('agreementType', 'not_allowed');
  if (given('title') && !fields.title?.trim()) return refuse('title', 'required');
  for (const field of ['effectiveOn', 'expiresOn'] as const) {
    const value = fields[field];
    if (typeof value === 'string' && !isCalendarDate(value)) return refuse(field, 'not_a_date');
  }
  if (reversed(fields.effectiveOn, fields.expiresOn))
    return refuse('expiresOn', 'expires_before_effective');
  return null;
}

/** The columns a write sets; an undefined field takes its default on insert and is kept on update. */
const columns = (fields: AgreementPatch) => ({
  ...{ agreementType: fields.agreementType, title: fields.title?.trim() },
  ...{ counterpartyPartyId: fields.counterpartyPartyId, assetId: fields.assetId },
  ...{ effectiveOn: fields.effectiveOn, expiresOn: fields.expiresOn, notes: fields.notes },
});

/** Agreement rows with their counterparty's display name, in a transaction or on the database. */
const withCounterparty = (db: Pick<WorkspaceTransaction, 'select'>) =>
  db
    .select({ agreement: agreements, counterpartyName: parties.displayName })
    .from(agreements)
    .leftJoin(parties, eq(parties.id, agreements.counterpartyPartyId));

type Loaded = Awaited<ReturnType<typeof withCounterparty>>[number];

const toDTO = ({ agreement, counterpartyName }: Loaded): AgreementDTO => ({
  ...agreement,
  agreementType: agreement.agreementType as AgreementType,
  counterpartyName,
});

/** The agreement an id names in this transaction; undefined when there is none. */
const load = async (tx: WorkspaceTransaction, id: string): Promise<Loaded | undefined> =>
  (await withCounterparty(tx).where(eq(agreements.id, id)))[0];

/**
 * Records an agreement (RGT-006) in one audited write transaction (§7.2). rights:update (D-5) and
 * VALIDATION come before the database opens. IntegrityGuard answers NOT_FOUND, with counts, for a
 * counterparty or asset id that names no live row in the tenant's own database (§3.1, §4.4 rule 1).
 * Audits agreement.create with the stored row (D-4).
 */
export async function createAgreement(
  tenant: TenantContext,
  input: AgreementInput,
): Promise<ServiceResult<AgreementDTO>> {
  if (!requirePermission(tenant, WRITE).ok) return failure('FORBIDDEN');
  const refused = invalid(input, true);
  if (refused) return refused;
  return runWorkspaceWrite(tenant, WRITE, async (tx, audit) => {
    const [id, at] = [`agr_${ulid()}`, new Date().toISOString()];
    await guard.insert(tx, agreements, [
      {
        ...{ id, ...columns(input), agreementType: input.agreementType, title: input.title.trim() },
        ...{ createdAt: at, updatedAt: at, createdBy: tenant.userId, updatedBy: tenant.userId },
      },
    ]);
    const created = await load(tx, id);
    if (!created) throw new Error(`Agreement ${id} was not stored`);
    await audit.write({
      ...{ action: 'agreement.create', entityType: 'agreement', entityId: id },
      ...{ before: null, after: created.agreement },
    });
    return success(toDTO(created));
  });
}

/**
 * Edits an agreement and audits agreement.update with the full row before and after (D-4); a patch
 * that changes nothing writes nothing. rights:update (D-5) and VALIDATION come before the database
 * opens. In the transaction, an id with no row in the tenant's own database is NOT_FOUND (§3.1,
 * TEN-001), `expiresOn` before `effectiveOn` once patched is VALIDATION, and IntegrityGuard refuses
 * a counterparty or asset with no live row.
 */
export async function updateAgreement(
  tenant: TenantContext,
  agreementId: string,
  patch: AgreementPatch,
): Promise<ServiceResult<AgreementDTO>> {
  if (!requirePermission(tenant, WRITE).ok) return failure('FORBIDDEN');
  const refused = invalid(patch, false);
  if (refused) return refused;
  return runWorkspaceWrite(tenant, WRITE, async (tx, audit) => {
    const before = await load(tx, agreementId);
    if (!before) return failure('NOT_FOUND');
    const kept = (field: 'effectiveOn' | 'expiresOn') =>
      patch[field] === undefined ? before.agreement[field] : patch[field];
    if (reversed(kept('effectiveOn'), kept('expiresOn')))
      return refuse('expiresOn', 'expires_before_effective');
    const set = columns(patch);
    const keys = Object.keys(set) as (keyof typeof set)[];
    if (keys.every((key) => [undefined, before.agreement[key]].includes(set[key])))
      return success(toDTO(before));
    const stamp = { updatedAt: new Date().toISOString(), updatedBy: tenant.userId };
    await guard.update(tx, agreements, { ...set, ...stamp }, eq(agreements.id, agreementId));
    const updated = await load(tx, agreementId);
    if (!updated) throw new Error(`Agreement ${agreementId} was not stored`);
    await audit.write({
      ...{ action: 'agreement.update', entityType: 'agreement', entityId: agreementId },
      ...{ before: before.agreement, after: updated.agreement },
    });
    return success(toDTO(updated));
  });
}

/**
 * The tenant's agreements by title ignoring case, then id, with counterparty names, for rights:read
 * (§6.2), filtered by `agreementType` and `counterpartyPartyId`. §4.3 gives `agreements` no
 * `deleted_at` and D-4 no agreement.delete, so every row is live. A refused role never opens the
 * database; one query.
 */
export async function listAgreements(
  tenant: TenantContext,
  { agreementType, counterpartyPartyId }: AgreementFilter = {},
): Promise<ServiceResult<AgreementDTO[]>> {
  if (!requirePermission(tenant, { rights: ['read'] }).ok) return failure('FORBIDDEN');
  const rows = await sanitized(tenant.workspaceId, async () => {
    const database = await getWorkspaceDatabase(tenant.workspaceId);
    const byType = agreementType ? eq(agreements.agreementType, agreementType) : undefined;
    const byParty = counterpartyPartyId
      ? eq(agreements.counterpartyPartyId, counterpartyPartyId)
      : undefined;
    return withCounterparty(database)
      .where(and(byType, byParty))
      .orderBy(asc(sql`lower(${agreements.title})`), asc(agreements.id));
  });
  return success(rows.map(toDTO));
}
