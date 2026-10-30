import { createHash } from 'node:crypto';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { monotonicFactory } from 'ulid';
import type { WorkspacePermissions } from '../../../lib/auth/permissions';
import {
  type RightsSummaryDTO,
  WRITER_ROLES,
  type WriterShareInput,
  type WriterSharesInput,
} from '../../../lib/dto/rights';
import {
  compositions,
  parties,
  compositionContributorRoles as roles,
  compositionContributors as writers,
} from '../../db/schema/workspace.generated';
import { canonicalJson } from '../audit-writer';
import { reindexSong } from '../catalog/search-index';
import { workspaceIntegrityGuard as guard } from '../integrity-guard';
import { requirePermission } from '../permissions';
import { failure, type ServiceResult, success } from '../service-result';
import type { TenantContext } from '../tenant-context';
import { getWorkspaceDatabase, sanitized } from '../workspace-connections';
import { runWorkspaceWrite, type WorkspaceTransaction } from '../workspace-write';
import { getRightsSummary } from './read';

const UPDATE: WorkspacePermissions = { rights: ['update'] };

/** A transaction or the database itself: writerSetOf only reads. */
type Reader = Pick<WorkspaceTransaction, 'select'>;
const MAX_BP = 10_000;

const refuse = (reason: string) => failure({ code: 'VALIDATION', field: 'shares', reason });

/**
 * How a full-set replace matches rows on their natural key (§4.4 share replacement): the rows
 * already held keep their ids, held rows missing from the new set are deleted, the rest are added.
 */
export function planByNaturalKey<R>(
  held: { id: string; key: string }[],
  rows: R[],
  keyOf: (row: R) => string,
) {
  const ids = new Map(held.map(({ id, key }) => [key, id]));
  const wanted = new Set(rows.map(keyOf));
  return {
    kept: rows.flatMap((row) => {
      const id = ids.get(keyOf(row));
      return id ? [{ id, row }] : [];
    }),
    added: rows.filter((row) => !ids.has(keyOf(row))),
    gone: held.filter(({ key }) => !wanted.has(key)).map(({ id }) => id),
  };
}

/** VALIDATION for the first broken share, before the database opens (RGT-004, D-3). */
function invalid(shares: WriterShareInput[]): ServiceResult<never> | null {
  if (new Set(shares.map((s) => s.partyId)).size < shares.length) return refuse('duplicate_party');
  for (const { roles: held, shareBp } of shares) {
    if (held.length < 1 || held.length > WRITER_ROLES.length) return refuse('roles_count');
    if (held.some((role) => !WRITER_ROLES.includes(role)) || new Set(held).size < held.length)
      return refuse('unknown_role');
    if (shareBp !== null && !(Number.isInteger(shareBp) && shareBp >= 0 && shareBp <= MAX_BP))
      return refuse('share_out_of_range');
  }
  const total = shares.reduce((sum, { shareBp }) => sum + (shareBp ?? 0), 0);
  return total > MAX_BP ? refuse('total_over_10000') : null;
}

/** A composition's writer set, canonical: by party id, each writer's roles sorted. */
async function writerSetOf(tx: Reader, compositionId: string) {
  const rows = await tx
    .select({ id: writers.id, partyId: writers.partyId, shareBp: writers.writerShareBp })
    .from(writers)
    .where(eq(writers.compositionId, compositionId))
    .orderBy(asc(writers.partyId));
  const held = rows.length
    ? await tx
        .select()
        .from(roles)
        .where(
          inArray(
            roles.contributorId,
            rows.map((row) => row.id),
          ),
        )
        .orderBy(asc(roles.role))
    : [];
  return rows.map((row) => ({
    ...row,
    roles: held.filter((r) => r.contributorId === row.id).map((r) => r.role),
  }));
}

/** SHA-256 of the canonical current writer set: the share tools' `beforeHash` (§7.4). */
export async function writerSharesHash(tx: Reader, compositionId: string) {
  const set = (await writerSetOf(tx, compositionId)).map(({ id: _, ...share }) => share);
  return createHash('sha256').update(canonicalJson(set)).digest('hex');
}

/**
 * The writer set's `beforeHash` as the editor loads it (RGT-001), for its Save to send back as
 * `expectedBeforeHash`. rights:read; a refused role never opens the database.
 */
export async function getWriterSharesHash(
  tenant: TenantContext,
  compositionId: string,
): Promise<ServiceResult<string>> {
  if (!requirePermission(tenant, { rights: ['read'] }).ok) return failure('FORBIDDEN');
  const hash = await sanitized(tenant.workspaceId, async () =>
    writerSharesHash(await getWorkspaceDatabase(tenant.workspaceId), compositionId),
  );
  return success(hash);
}

/**
 * Replaces a composition's writer shares with `input.shares` (RGT-001, §4.4) in one audited write.
 * rights:update (§6.2) and VALIDATION come first, before the database opens: each party once, 1 to
 * 4 known roles, each share 0 to 10000 bp and a total of at most 10000 (D-3; a lower total is
 * allowed and readiness reports it). A composition or party with no live row is NOT_FOUND; an
 * organization is VALIDATION person_required; a stale `expectedBeforeHash` is STATE_CHANGED. Rows
 * keep their ids by party; a removed writer is deleted through the guard with his roles. The song is
 * reindexed (G-13) and writer_shares.replace audited; then returns the RightsSummaryDTO.
 */
export async function updateWriterShares(
  tenant: TenantContext,
  input: WriterSharesInput,
): Promise<ServiceResult<RightsSummaryDTO>> {
  if (!requirePermission(tenant, UPDATE).ok) return failure('FORBIDDEN');
  const refused = invalid(input.shares);
  if (refused) return refused;
  const { compositionId, shares } = input;
  const written = await runWorkspaceWrite(tenant, UPDATE, async (tx, audit) => {
    const live = and(eq(compositions.id, compositionId), isNull(compositions.deletedAt));
    if (!(await tx.select({ id: compositions.id }).from(compositions).where(live)).length)
      return failure('NOT_FOUND');
    if (input.expectedBeforeHash !== undefined) {
      const current = await writerSharesHash(tx, compositionId);
      if (current !== input.expectedBeforeHash) return failure('STATE_CHANGED');
    }
    const ids = shares.map((share) => share.partyId);
    const named = ids.length
      ? await tx
          .select({ id: parties.id, partyKind: parties.partyKind })
          .from(parties)
          .where(and(inArray(parties.id, ids), isNull(parties.deletedAt)))
      : [];
    if (named.length < ids.length) return failure('NOT_FOUND');
    if (named.some((party) => party.partyKind !== 'person')) return refuse('person_required');
    const before = await writerSetOf(tx, compositionId);
    const plan = planByNaturalKey(
      before.map(({ id, partyId }) => ({ id, key: partyId })),
      shares,
      (share) => share.partyId,
    );
    const [next, at, by] = [monotonicFactory(), new Date().toISOString(), tenant.userId];
    if (plan.gone.length) await guard.delete(tx, writers, inArray(writers.id, plan.gone));
    for (const { id, row } of plan.kept)
      await guard.update(
        tx,
        writers,
        { writerShareBp: row.shareBp, updatedAt: at, updatedBy: by },
        eq(writers.id, id),
      );
    const added = plan.added.map((row) => ({ id: `ctr_${next()}`, row }));
    if (added.length)
      await guard.insert(
        tx,
        writers,
        added.map(({ id, row }) => ({
          ...{ id, compositionId, partyId: row.partyId, writerShareBp: row.shareBp },
          ...{ createdAt: at, updatedAt: at, createdBy: by, updatedBy: by },
        })),
      );
    const all = [...plan.kept, ...added];
    await guard.delete(
      tx,
      roles,
      inArray(
        roles.contributorId,
        all.map(({ id }) => id),
      ),
    );
    const roleRows = all.flatMap(({ id, row }) =>
      row.roles.map((role) => ({ contributorId: id, role })),
    );
    if (roleRows.length) await guard.insert(tx, roles, roleRows);
    await reindexSong(tx, compositionId);
    await audit.write({
      ...{ action: 'writer_shares.replace', entityType: 'composition', entityId: compositionId },
      ...{ before: { shares: before }, after: { shares: await writerSetOf(tx, compositionId) } },
    });
    return success(compositionId);
  });
  return written.ok
    ? getRightsSummary(tenant, { entityType: 'composition', entityId: written.value })
    : written;
}
