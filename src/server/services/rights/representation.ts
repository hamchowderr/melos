import { createHash } from 'node:crypto';
import { and, asc, eq, inArray, isNull, type SQL } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { ApprovalRow } from '../../../lib/agent/approval';
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
  parties,
  publishingInterests,
  recordings,
} from '../../db/schema/workspace.generated';
import { canonicalJson } from '../audit-writer';
import { workspaceIntegrityGuard as guard } from '../integrity-guard';
import { requirePermission } from '../permissions';
import { failure, type ServiceResult, success } from '../service-result';
import type { TenantContext } from '../tenant-context';
import { getWorkspaceDatabase, sanitized } from '../workspace-connections';
import { runWorkspaceWrite, type WorkspaceTransaction, type WriteOrigin } from '../workspace-write';
import { getRightsSummary } from './read';

/** A transaction or the database itself: the loaders only read. */
type Reader = Pick<WorkspaceTransaction, 'select'>;

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
  tx: Reader,
  from: typeof compositions | typeof recordings,
  where: SQL | undefined,
) {
  const [row] = await tx.select({ id: from.id }).from(from).where(where).limit(1);
  return row !== undefined;
}

/** The song's RightsSummaryDTO, read after the write commits. */
const summaryOf = (tenant: TenantContext, focus: CatalogFocus) => getRightsSummary(tenant, focus);

const hashOf = (state: unknown) => createHash('sha256').update(canonicalJson(state)).digest('hex');

/** An interest row and its live composition or recording; NOT_FOUND when either is missing. */
async function interestOf(tx: Reader, input: RepresentationInput) {
  const side = SIDES[input.interestType];
  const [before] = await tx.select().from(side.table).where(eq(side.table.id, input.interestId));
  if (!before) return failure('NOT_FOUND');
  const parentId =
    input.interestType === 'publishing'
      ? (before as typeof publishingInterests.$inferSelect).compositionId
      : (before as typeof masterInterests.$inferSelect).recordingId;
  if (!(await exists(tx, side.from, side.live(parentId)))) return failure('NOT_FOUND');
  const partyId =
    input.interestType === 'publishing'
      ? (before as typeof publishingInterests.$inferSelect).publisherPartyId
      : (before as typeof masterInterests.$inferSelect).ownerPartyId;
  return success({ before, parentId, partyId });
}

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
  input: RepresentationInput & { expectedBeforeHash?: string },
  origin?: WriteOrigin,
): Promise<ServiceResult<RightsSummaryDTO>> {
  if (!requirePermission(tenant, WRITE).ok) return failure('FORBIDDEN');
  const side = SIDES[input.interestType];
  if (!side) return refuse('interestType', 'not_allowed');
  if (typeof input.attested !== 'boolean') return refuse('attested', 'required');
  const written = await runWorkspaceWrite(
    tenant,
    WRITE,
    async (tx, audit) => {
      const { table } = side;
      const loaded = await interestOf(tx, input);
      if (!loaded.ok) return loaded;
      const { before, parentId } = loaded.value;
      if (input.expectedBeforeHash !== undefined && hashOf(before) !== input.expectedBeforeHash)
        return failure('STATE_CHANGED');
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
    },
    origin,
  );
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
  input: LicensingContactsInput & { expectedBeforeHash?: string },
  origin?: WriteOrigin,
): Promise<ServiceResult<RightsSummaryDTO>> {
  if (!requirePermission(tenant, WRITE).ok) return failure('FORBIDDEN');
  const refused = invalidContacts(input);
  if (refused) return refused;
  const written = await runWorkspaceWrite(
    tenant,
    WRITE,
    async (tx, audit) => {
      const isRecording = Boolean(input.recordingId);
      const targetId = (input.recordingId ?? input.compositionId) as string;
      const side = isRecording ? SIDES.master : SIDES.publishing;
      if (!(await exists(tx, side.from, side.live(targetId)))) return failure('NOT_FOUND');
      const column = isRecording ? licensingContacts.recordingId : licensingContacts.compositionId;
      const own = eq(column, targetId);
      const load = () =>
        tx
          .select(CONTACT)
          .from(licensingContacts)
          .where(own)
          .orderBy(asc(licensingContacts.partyId));
      const before = await load();
      if (input.expectedBeforeHash !== undefined && hashOf(before) !== input.expectedBeforeHash)
        return failure('STATE_CHANGED');
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
        ...{
          action: 'licensing_contacts.replace',
          entityType: side.entityType,
          entityId: targetId,
        },
        ...{ before: { contacts: before }, after: { contacts: await load() } },
      });
      return success(targetId);
    },
    origin,
  );
  if (!written.ok) return written;
  const entityType = input.recordingId ? 'recording' : 'composition';
  return summaryOf(tenant, { entityType, entityId: written.value });
}

type Preview = { before: ApprovalRow[]; after: ApprovalRow[]; beforeHash: string };

/** Display names of parties, for a preview's rows. */
async function namesOf(db: Reader, ids: string[]) {
  if (!ids.length) return new Map<string, string>();
  const rows = await db
    .select({ id: parties.id, name: parties.displayName })
    .from(parties)
    .where(inArray(parties.id, ids));
  return new Map(rows.map(({ id, name }) => [id, name]));
}

/**
 * What an approval of attestRepresentation shows and re-checks (§7.4 step 1), writing nothing: the
 * holder with its attestation before and after, and the interest row's `beforeHash`.
 */
export async function previewRepresentation(
  tenant: TenantContext,
  input: RepresentationInput,
): Promise<ServiceResult<Preview & { target: CatalogFocus }>> {
  if (!requirePermission(tenant, WRITE).ok) return failure('FORBIDDEN');
  if (!SIDES[input.interestType]) return refuse('interestType', 'not_allowed');
  if (typeof input.attested !== 'boolean') return refuse('attested', 'required');
  return sanitized(tenant.workspaceId, async () => {
    const db = await getWorkspaceDatabase(tenant.workspaceId);
    const loaded = await interestOf(db, input);
    if (!loaded.ok) return loaded;
    const { before, parentId, partyId } = loaded.value;
    const label = (await namesOf(db, [partyId])).get(partyId) ?? partyId;
    const side = `${input.interestType === 'publishing' ? 'Publishing' : 'Master'}`;
    const row = (attested: boolean) => ({
      ...{ id: input.interestId, label },
      detail: `${side} · ${attested ? 'representation attested' : 'not attested'}`,
    });
    return success({
      before: [row(Boolean(before.representationAttestedAt))],
      after: [row(input.attested)],
      beforeHash: hashOf(before),
      target: { entityType: SIDES[input.interestType].entityType, entityId: parentId },
    });
  });
}

/**
 * What an approval of updateLicensingContacts shows and re-checks, writing nothing: the target's
 * contacts by name before and after, and the current contact set's `beforeHash`.
 */
export async function previewLicensingContacts(
  tenant: TenantContext,
  input: LicensingContactsInput,
): Promise<ServiceResult<Preview>> {
  if (!requirePermission(tenant, WRITE).ok) return failure('FORBIDDEN');
  const refused = invalidContacts(input);
  if (refused) return refused;
  return sanitized(tenant.workspaceId, async () => {
    const db = await getWorkspaceDatabase(tenant.workspaceId);
    const targetId = (input.recordingId ?? input.compositionId) as string;
    const side = input.recordingId ? SIDES.master : SIDES.publishing;
    if (!(await exists(db, side.from, side.live(targetId)))) return failure('NOT_FOUND');
    const column = input.recordingId
      ? licensingContacts.recordingId
      : licensingContacts.compositionId;
    const before = await db
      .select(CONTACT)
      .from(licensingContacts)
      .where(eq(column, targetId))
      .orderBy(asc(licensingContacts.partyId));
    const ids = [...before, ...input.contacts].map(({ partyId }) => partyId);
    // IntegrityGuard refuses these on the write; the preview refuses them first.
    const wanted = input.contacts.map(({ partyId }) => partyId);
    const live = wanted.length
      ? await db
          .select({ id: parties.id })
          .from(parties)
          .where(and(inArray(parties.id, wanted), isNull(parties.deletedAt)))
      : [];
    if (live.length < wanted.length) return failure('NOT_FOUND');
    const names = await namesOf(db, [...new Set(ids)]);
    const row = ({ partyId, notes }: { partyId: string; notes?: string | null }) => ({
      ...{ id: partyId, label: names.get(partyId) ?? partyId },
      ...(notes ? { detail: notes } : {}),
    });
    return success({
      before: before.map(row),
      after: input.contacts.map(row),
      beforeHash: hashOf(before),
    });
  });
}
