import { createHash } from 'node:crypto';
import { and, asc, eq, inArray, isNull, ne } from 'drizzle-orm';
import { monotonicFactory } from 'ulid';
import type { WorkspacePermissions } from '../../../lib/auth/permissions';
import type {
  HolderShareInput,
  MasterSharesInput,
  PublishingSharesInput,
  RightsSummaryDTO,
} from '../../../lib/dto/rights';
import {
  compositions,
  masterInterests as masters,
  parties,
  publishingInterests as publishers,
  recordings,
} from '../../db/schema/workspace.generated';
import { canonicalJson } from '../audit-writer';
import { workspaceIntegrityGuard as guard } from '../integrity-guard';
import { requirePermission } from '../permissions';
import { failure, type ServiceResult, success } from '../service-result';
import type { TenantContext } from '../tenant-context';
import { getWorkspaceDatabase, sanitized } from '../workspace-connections';
import { runWorkspaceWrite, type WorkspaceTransaction } from '../workspace-write';
import { getRightsSummary } from './read';
import { planByNaturalKey } from './shares';

const UPDATE: WorkspacePermissions = { rights: ['update'] };
const MAX_BP = 10_000;
const TERRITORY = /^(WORLD|[A-Z]{2})$/;

const refuse = (field: string, reason: string) => failure({ code: 'VALIDATION', field, reason });

/** VALIDATION for the first broken share, before the database opens (RGT-004, D-3). */
function invalid(shares: HolderShareInput[]): ServiceResult<never> | null {
  if (new Set(shares.map((s) => s.partyId)).size < shares.length)
    return refuse('shares', 'duplicate_party');
  if (
    shares.some(({ shareBp }) => !(Number.isInteger(shareBp) && shareBp >= 0 && shareBp <= MAX_BP))
  )
    return refuse('shares', 'share_out_of_range');
  const total = shares.reduce((sum, { shareBp }) => sum + shareBp, 0);
  return total > MAX_BP ? refuse('shares', 'total_over_10000') : null;
}

/** Whether every named party has a live row. */
async function liveParties(tx: WorkspaceTransaction, shares: HolderShareInput[]) {
  const ids = shares.map(({ partyId }) => partyId);
  if (!ids.length) return true;
  const live = and(inArray(parties.id, ids), isNull(parties.deletedAt));
  return (await tx.select({ id: parties.id }).from(parties).where(live)).length === ids.length;
}

type Held = {
  id: string;
  partyId: string;
  shareBp: number;
  agreementId: string | null;
  representationAttestedAt: string | null;
};

/** SHA-256 of a canonical holder set, by party: the share tools' `beforeHash` (§7.4). */
export const holderSetHash = (held: Held[]) =>
  createHash('sha256')
    .update(canonicalJson(held.map(({ id: _, ...share }) => share)))
    .digest('hex');

export type HolderHashes = {
  publishing: Record<string, string>;
  masters: Record<string, string>;
  empty: string;
};

/** Each set's hash, keyed by its territory or recording, from rows in party order. */
const hashesOf = (rows: (Held & { key: string })[]) => {
  const sets = Map.groupBy(rows, ({ key }) => key);
  return Object.fromEntries(
    [...sets].map(([key, held]) => [key, holderSetHash(held.map(({ key: _, ...row }) => row))]),
  );
};

/**
 * The publishing hashes by territory and the master hashes by recording, as the split editors load
 * them (RGT-002, RGT-003), for Save to send back as `expectedBeforeHash`. A set with no rows has no
 * entry; its editor sends `empty`, the hash of no rows. rights:read; a refused role never opens the
 * database.
 */
export async function getHolderSharesHashes(
  tenant: TenantContext,
  { compositionId, recordingIds }: { compositionId: string | null; recordingIds: string[] },
): Promise<ServiceResult<HolderHashes>> {
  if (!requirePermission(tenant, { rights: ['read'] }).ok) return failure('FORBIDDEN');
  return sanitized(tenant.workspaceId, async () => {
    const db = await getWorkspaceDatabase(tenant.workspaceId);
    const { id, shareBp, agreementId, representationAttestedAt } = publishers;
    const held = { id, shareBp, agreementId, representationAttestedAt };
    const publishing = compositionId
      ? await db
          .select({ ...held, key: publishers.territory, partyId: publishers.publisherPartyId })
          .from(publishers)
          .where(eq(publishers.compositionId, compositionId))
          .orderBy(asc(publishers.publisherPartyId))
      : [];
    const owned = await db
      .select({
        ...{ id: masters.id, shareBp: masters.shareBp, agreementId: masters.agreementId },
        representationAttestedAt: masters.representationAttestedAt,
        ...{ key: masters.recordingId, partyId: masters.ownerPartyId },
      })
      .from(masters)
      .where(inArray(masters.recordingId, recordingIds))
      .orderBy(asc(masters.ownerPartyId));
    return success({
      ...{ publishing: hashesOf(publishing), masters: hashesOf(owned) },
      empty: holderSetHash([]),
    });
  });
}

const stamps = (tenant: TenantContext) => {
  const at = new Date().toISOString();
  return { at, by: tenant.userId, next: monotonicFactory() };
};

/**
 * Replaces one territory's publishing shares on a composition (RGT-002, RGT-007) in one audited
 * write, upserting on (composition, publisher, territory) so a holder in both sets keeps its id and
 * its attestation (D-13). rights:update and VALIDATION come first. A composition or party with no
 * live row, or an agreement with no row, is NOT_FOUND; a WORLD set beside country sets is VALIDATION
 * (P-05); a stale `expectedBeforeHash` is STATE_CHANGED. Audits publishing_shares.replace.
 */
export async function updatePublishingShares(
  tenant: TenantContext,
  input: PublishingSharesInput,
): Promise<ServiceResult<RightsSummaryDTO>> {
  if (!requirePermission(tenant, UPDATE).ok) return failure('FORBIDDEN');
  if (!TERRITORY.test(input.territory)) return refuse('territory', 'unknown_territory');
  const refused = invalid(input.shares);
  if (refused) return refused;
  const { compositionId, territory, shares } = input;
  const written = await runWorkspaceWrite(tenant, UPDATE, async (tx, audit) => {
    const live = and(eq(compositions.id, compositionId), isNull(compositions.deletedAt));
    if (!(await tx.select({ id: compositions.id }).from(compositions).where(live)).length)
      return failure('NOT_FOUND');
    if (!(await liveParties(tx, shares))) return failure('NOT_FOUND');
    const song = eq(publishers.compositionId, compositionId);
    const other =
      territory === 'WORLD' ? ne(publishers.territory, 'WORLD') : eq(publishers.territory, 'WORLD');
    const [mixed] = await tx.select({ id: publishers.id }).from(publishers).where(and(song, other));
    if (mixed && shares.length) return refuse('territory', 'mixes_world_and_countries');
    const { id, shareBp, agreementId, representationAttestedAt } = publishers;
    const before: Held[] = await tx
      .select({
        id,
        partyId: publishers.publisherPartyId,
        shareBp,
        agreementId,
        representationAttestedAt,
      })
      .from(publishers)
      .where(and(song, eq(publishers.territory, territory)))
      .orderBy(asc(publishers.publisherPartyId));
    if (
      input.expectedBeforeHash !== undefined &&
      holderSetHash(before) !== input.expectedBeforeHash
    )
      return failure('STATE_CHANGED');
    const plan = planByNaturalKey(
      before.map((row) => ({ id: row.id, key: row.partyId })),
      shares,
      (share) => share.partyId,
    );
    const { at, by, next } = stamps(tenant);
    if (plan.gone.length) await guard.delete(tx, publishers, inArray(publishers.id, plan.gone));
    for (const { id: kept, row } of plan.kept)
      await guard.update(
        tx,
        publishers,
        {
          shareBp: row.shareBp,
          agreementId: row.agreementId ?? null,
          updatedAt: at,
          updatedBy: by,
        },
        eq(publishers.id, kept),
      );
    if (plan.added.length)
      await guard.insert(
        tx,
        publishers,
        plan.added.map((row) => ({
          ...{ id: next(), compositionId, publisherPartyId: row.partyId, territory },
          ...{ shareBp: row.shareBp, agreementId: row.agreementId ?? null },
          ...{ createdAt: at, updatedAt: at, createdBy: by, updatedBy: by },
        })),
      );
    const after = await tx
      .select()
      .from(publishers)
      .where(and(song, eq(publishers.territory, territory)))
      .orderBy(asc(publishers.publisherPartyId));
    await audit.write({
      ...{
        action: 'publishing_shares.replace',
        entityType: 'composition',
        entityId: compositionId,
      },
      ...{ before: { territory, shares: before }, after: { territory, shares: after } },
    });
    return success(compositionId);
  });
  return written.ok
    ? getRightsSummary(tenant, { entityType: 'composition', entityId: written.value })
    : written;
}

/**
 * Replaces a recording's master shares (RGT-003) in one audited write, upserting on (recording,
 * owner) so a holder in both sets keeps its id and its attestation (D-13). rights:update and
 * VALIDATION come first. A recording or party with no live row, or an agreement with no row, is
 * NOT_FOUND; a stale `expectedBeforeHash` is STATE_CHANGED. Audits master_shares.replace.
 */
export async function updateMasterShares(
  tenant: TenantContext,
  input: MasterSharesInput,
): Promise<ServiceResult<RightsSummaryDTO>> {
  if (!requirePermission(tenant, UPDATE).ok) return failure('FORBIDDEN');
  const refused = invalid(input.shares);
  if (refused) return refused;
  const { recordingId, shares } = input;
  const written = await runWorkspaceWrite(tenant, UPDATE, async (tx, audit) => {
    const live = and(eq(recordings.id, recordingId), isNull(recordings.deletedAt));
    if (!(await tx.select({ id: recordings.id }).from(recordings).where(live)).length)
      return failure('NOT_FOUND');
    if (!(await liveParties(tx, shares))) return failure('NOT_FOUND');
    const take = eq(masters.recordingId, recordingId);
    const { id, shareBp, agreementId, representationAttestedAt } = masters;
    const before: Held[] = await tx
      .select({ id, partyId: masters.ownerPartyId, shareBp, agreementId, representationAttestedAt })
      .from(masters)
      .where(take)
      .orderBy(asc(masters.ownerPartyId));
    if (
      input.expectedBeforeHash !== undefined &&
      holderSetHash(before) !== input.expectedBeforeHash
    )
      return failure('STATE_CHANGED');
    const plan = planByNaturalKey(
      before.map((row) => ({ id: row.id, key: row.partyId })),
      shares,
      (share) => share.partyId,
    );
    const { at, by, next } = stamps(tenant);
    if (plan.gone.length) await guard.delete(tx, masters, inArray(masters.id, plan.gone));
    for (const { id: kept, row } of plan.kept)
      await guard.update(
        tx,
        masters,
        {
          shareBp: row.shareBp,
          agreementId: row.agreementId ?? null,
          updatedAt: at,
          updatedBy: by,
        },
        eq(masters.id, kept),
      );
    if (plan.added.length)
      await guard.insert(
        tx,
        masters,
        plan.added.map((row) => ({
          ...{ id: next(), recordingId, ownerPartyId: row.partyId },
          ...{ shareBp: row.shareBp, agreementId: row.agreementId ?? null },
          ...{ createdAt: at, updatedAt: at, createdBy: by, updatedBy: by },
        })),
      );
    const after = await tx.select().from(masters).where(take).orderBy(asc(masters.ownerPartyId));
    await audit.write({
      ...{ action: 'master_shares.replace', entityType: 'recording', entityId: recordingId },
      ...{ before: { shares: before }, after: { shares: after } },
    });
    return success(recordingId);
  });
  return written.ok
    ? getRightsSummary(tenant, { entityType: 'recording', entityId: written.value })
    : written;
}
