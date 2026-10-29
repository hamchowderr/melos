import { and, asc, eq, inArray, isNull, type SQL } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { WorkspacePermissions } from '../../../lib/auth/permissions';
import type { CatalogFocus } from '../../../lib/dto/catalog';
import type {
  LicensingContactsInput,
  RepresentationInput,
  RightsSummaryDTO,
} from '../../../lib/dto/rights';
import {
  compositions,
  licensingContacts,
  masterInterests,
  publishingInterests,
  recordings,
} from '../../db/schema/workspace.generated';
import { workspaceIntegrityGuard as guard } from '../integrity-guard';
import { requirePermission } from '../permissions';
import { failure, type ServiceResult, success } from '../service-result';
import type { TenantContext } from '../tenant-context';
import { runWorkspaceWrite, type WorkspaceTransaction } from '../workspace-write';
import { getRightsSummary } from './read';

const WRITE: WorkspacePermissions = { rights: ['update'] };

const refuse = (field: string, reason: string) => failure({ code: 'VALIDATION', field, reason });

/** The interest table and its parent's table and audit entity type, by `interestType`. */
const SIDES = {
  publishing: {
    table: publishingInterests,
    live: (id: string) => and(eq(compositions.id, id), isNull(compositions.deletedAt)),
    from: compositions,
    entityType: 'composition' as const,
  },
  master: {
    table: masterInterests,
    live: (id: string) => and(eq(recordings.id, id), isNull(recordings.deletedAt)),
    from: recordings,
    entityType: 'recording' as const,
  },
};

/** True when the composition or recording `where` names has a live row. */
async function exists(
  tx: WorkspaceTransaction,
  from: typeof compositions | typeof recordings,
  where: SQL | undefined,
) {
  const [row] = await tx.select({ id: from.id }).from(from).where(where).limit(1);
  return row !== undefined;
}

/** The song's RightsSummaryDTO, read after the write commits. */
const summaryOf = (tenant: TenantContext, focus: CatalogFocus) => getRightsSummary(tenant, focus);

/**
 * Sets or clears the representation attestation on one publishing or master interest (RGT-005,
 * RGT-006, §3.3) in one audited write transaction. rights:update (§6.2) and VALIDATION come first;
 * an interest whose composition or recording has no live row is NOT_FOUND. Setting stamps
 * `representation_attested_at` and `_by` and links `agreementId` when given (omitted keeps the
 * link); IntegrityGuard refuses an agreement with no row as NOT_FOUND. Clearing empties the
 * attestation and the agreement link together (melos-rpr.23). A call that changes nothing writes
 * nothing. Audits representation.attest or representation.clear with the interest row before and
 * after (§6.6), then returns the song's RightsSummaryDTO.
 */
export async function attestRepresentation(
  tenant: TenantContext,
  input: RepresentationInput,
): Promise<ServiceResult<RightsSummaryDTO>> {
  if (!requirePermission(tenant, WRITE).ok) return failure('FORBIDDEN');
  const side = SIDES[input.interestType];
  if (!side) return refuse('interestType', 'not_allowed');
  if (typeof input.attested !== 'boolean') return refuse('attested', 'required');
  const written = await runWorkspaceWrite(tenant, WRITE, async (tx, audit) => {
    const { table } = side;
    const [before] = await tx.select().from(table).where(eq(table.id, input.interestId));
    if (!before) return failure('NOT_FOUND');
    const parentId =
      input.interestType === 'publishing'
        ? (before as typeof publishingInterests.$inferSelect).compositionId
        : (before as typeof masterInterests.$inferSelect).recordingId;
    if (!(await exists(tx, side.from, side.live(parentId)))) return failure('NOT_FOUND');
    const focus = { entityType: side.entityType, entityId: parentId };
    const agreementId = input.attested
      ? input.agreementId === undefined
        ? before.agreementId
        : input.agreementId
      : null;
    if (
      Boolean(before.representationAttestedAt) === input.attested &&
      before.agreementId === agreementId
    )
      return success(focus);
    const at = new Date().toISOString();
    const attestation = input.attested
      ? { representationAttestedAt: at, representationAttestedBy: tenant.userId }
      : { representationAttestedAt: null, representationAttestedBy: null };
    const set = { ...attestation, agreementId, updatedAt: at, updatedBy: tenant.userId };
    await guard.update(tx, table, set, eq(table.id, input.interestId));
    const [after] = await tx.select().from(table).where(eq(table.id, input.interestId));
    await audit.write({
      action: input.attested ? 'representation.attest' : 'representation.clear',
      ...{ entityType: `${input.interestType}_interest`, entityId: input.interestId },
      ...{ before, after },
    });
    return success(focus);
  });
  return written.ok ? summaryOf(tenant, written.value) : written;
}

/**
 * VALIDATION for updateLicensingContacts before the database opens: exactly one target, a list of
 * contacts, each with a party id, each party once.
 */
function invalidContacts({ recordingId, compositionId, contacts }: LicensingContactsInput) {
  if (!recordingId === !compositionId) return refuse('target', 'exactly_one');
  if (!Array.isArray(contacts)) return refuse('contacts', 'required');
  if (contacts.some((contact) => !contact?.partyId)) return refuse('contacts', 'party_required');
  const parties = contacts.map(({ partyId }) => partyId);
  if (new Set(parties).size < parties.length) return refuse('contacts', 'duplicate_party');
  return null;
}

const CONTACT = {
  id: licensingContacts.id,
  partyId: licensingContacts.partyId,
  agreementId: licensingContacts.agreementId,
  notes: licensingContacts.notes,
};

/**
 * Replaces the licensing contacts of one recording or composition (RGT-005, §3.3) in one audited
 * write transaction, matched by party: a kept party keeps its row and is updated only when its
 * agreement or notes change. rights:update (§6.2) and VALIDATION come first; a target with no live
 * row is NOT_FOUND, and IntegrityGuard refuses a party or agreement with no live row as NOT_FOUND
 * with counts. A set that changes nothing writes nothing. Audits licensing_contacts.replace on the
 * target with its contacts before and after (§6.6), then returns the song's RightsSummaryDTO.
 */
export async function updateLicensingContacts(
  tenant: TenantContext,
  input: LicensingContactsInput,
): Promise<ServiceResult<RightsSummaryDTO>> {
  if (!requirePermission(tenant, WRITE).ok) return failure('FORBIDDEN');
  const refused = invalidContacts(input);
  if (refused) return refused;
  const written = await runWorkspaceWrite(tenant, WRITE, async (tx, audit) => {
    const isRecording = Boolean(input.recordingId);
    const targetId = (input.recordingId ?? input.compositionId) as string;
    const side = isRecording ? SIDES.master : SIDES.publishing;
    if (!(await exists(tx, side.from, side.live(targetId)))) return failure('NOT_FOUND');
    const column = isRecording ? licensingContacts.recordingId : licensingContacts.compositionId;
    const own = eq(column, targetId);
    const load = () =>
      tx.select(CONTACT).from(licensingContacts).where(own).orderBy(asc(licensingContacts.partyId));
    const before = await load();
    const wanted = input.contacts.map(({ partyId, agreementId = null, notes = null }) => ({
      ...{ partyId, agreementId, notes },
    }));
    const held = new Map(before.map((row) => [row.partyId, row]));
    const dropped = before.filter((row) => !wanted.some((w) => w.partyId === row.partyId));
    const added = wanted.filter((w) => !held.has(w.partyId));
    const changed = wanted.filter((w) => {
      const row = held.get(w.partyId);
      return row && (row.agreementId !== w.agreementId || row.notes !== w.notes);
    });
    if (!dropped.length && !added.length && !changed.length) return success(targetId);
    const at = new Date().toISOString();
    const by = { updatedAt: at, updatedBy: tenant.userId };
    if (dropped.length)
      await guard.delete(
        tx,
        licensingContacts,
        and(
          own,
          inArray(
            licensingContacts.id,
            dropped.map(({ id }) => id),
          ),
        ) as SQL,
      );
    for (const { partyId, agreementId, notes } of changed) {
      const row = and(own, eq(licensingContacts.partyId, partyId)) as SQL;
      await guard.update(tx, licensingContacts, { agreementId, notes, ...by }, row);
    }
    if (added.length)
      await guard.insert(
        tx,
        licensingContacts,
        added.map((contact) => ({
          ...{ id: `lic_${ulid()}`, ...contact, createdAt: at, createdBy: tenant.userId, ...by },
          recordingId: isRecording ? targetId : null,
          compositionId: isRecording ? null : targetId,
        })),
      );
    await audit.write({
      ...{ action: 'licensing_contacts.replace', entityType: side.entityType, entityId: targetId },
      ...{ before: { contacts: before }, after: { contacts: await load() } },
    });
    return success(targetId);
  });
  if (!written.ok) return written;
  const entityType = input.recordingId ? 'recording' : 'composition';
  return summaryOf(tenant, { entityType, entityId: written.value });
}
