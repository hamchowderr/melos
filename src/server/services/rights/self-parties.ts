import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { PartyKind } from '../../../lib/dto/contacts';
import {
  SELF_PARTY_SIDES,
  type SelfPartiesDTO,
  type SelfPartiesInput,
  type SelfPartySide,
} from '../../../lib/dto/self-parties';
import { parties, workspaceSelfParties } from '../../db/schema/workspace.generated';
import { workspaceIntegrityGuard as guard } from '../integrity-guard';
import { requirePermission } from '../permissions';
import { failure, type ServiceResult, success } from '../service-result';
import type { TenantContext } from '../tenant-context';
import { getWorkspaceDatabase, sanitized } from '../workspace-connections';
import { runWorkspaceWrite, type WorkspaceTransaction } from '../workspace-write';

/** The stored workspace_self_parties rows, each with its party's name. */
const selfPartyRows = (db: Pick<WorkspaceTransaction, 'select'>) =>
  db
    .select({ row: workspaceSelfParties, displayName: parties.displayName })
    .from(workspaceSelfParties)
    .innerJoin(parties, eq(parties.id, workspaceSelfParties.partyId));

type SelfPartyRow = Awaited<ReturnType<typeof selfPartyRows>>[number];

/** One entry per side, from its row, or null when the side has no row. */
function bySide<T>(rows: SelfPartyRow[], pick: (row: SelfPartyRow) => T) {
  const found = new Map(rows.map((row) => [row.row.side, pick(row)]));
  const sides = SELF_PARTY_SIDES.map((side) => [side, found.get(side) ?? null]);
  return Object.fromEntries(sides) as Record<SelfPartySide, T | null>;
}

const toDto = (rows: SelfPartyRow[]): SelfPartiesDTO =>
  bySide(rows, ({ row, displayName }) => ({
    ...{ partyId: row.partyId, partyKind: row.partyKind as PartyKind, displayName },
  }));

/**
 * Each side's self party (RGT-008) for rights:read, which every role holds (§6.2); a refused role,
 * such as a comma role (P-30), never opens the database. One batch.
 */
export async function getSelfParties(
  tenant: TenantContext,
): Promise<ServiceResult<SelfPartiesDTO>> {
  if (!requirePermission(tenant, { rights: ['read'] }).ok) return failure('FORBIDDEN');
  const [rows] = await sanitized(tenant.workspaceId, async () => {
    const database = await getWorkspaceDatabase(tenant.workspaceId);
    return database.batch([selfPartyRows(database)]);
  });
  return success(toDto(rows));
}

/**
 * Stores the full set with rights:update (D-5) in one workspace write (§7.2): a side given a party
 * id upserts its row and a null side deletes it through IntegrityGuard. Before anything is written,
 * an id with no live party in the tenant's own database is NOT_FOUND with the missing count, and an
 * organization on the writer side is VALIDATION, which the §4.2 CHECK would otherwise refuse. A save
 * that changes a side writes one `self_parties.update` audit row with every side's stored row before
 * and after (§6.6); a save that changes nothing writes nothing.
 */
export async function updateSelfParties(
  tenant: TenantContext,
  input: SelfPartiesInput,
): Promise<ServiceResult<SelfPartiesDTO>> {
  return runWorkspaceWrite(tenant, { rights: ['update'] }, async (tx, audit) => {
    const ids = [...new Set(SELF_PARTY_SIDES.flatMap((side) => input[side] ?? []))];
    const live = and(inArray(parties.id, ids), isNull(parties.deletedAt));
    const kinds = ids.length
      ? await tx.select({ id: parties.id, kind: parties.partyKind }).from(parties).where(live)
      : [];
    const kindOf = new Map(kinds.map(({ id, kind }) => [id, kind]));
    const missing = ids.length - kinds.length;
    if (missing) return failure({ code: 'NOT_FOUND', counts: { parties: missing } });
    if (input.writer && kindOf.get(input.writer) !== 'person') {
      return failure({ code: 'VALIDATION', field: 'writer', reason: 'person_required' });
    }

    const read = await selfPartyRows(tx);
    const before = bySide(read, ({ row }) => row);
    const changed = SELF_PARTY_SIDES.filter(
      (side) => (before[side]?.partyId ?? null) !== input[side],
    );
    if (changed.length === 0) return success(toDto(read));
    const updatedAt = new Date().toISOString();
    for (const side of changed) {
      const partyId = input[side];
      const where = eq(workspaceSelfParties.side, side);
      if (partyId === null) {
        await guard.delete(tx, workspaceSelfParties, where);
        continue;
      }
      const values = { partyId, partyKind: kindOf.get(partyId) as string, updatedAt };
      const stamped = { ...values, updatedBy: tenant.userId };
      if (before[side]) await guard.update(tx, workspaceSelfParties, stamped, where);
      else await guard.insert(tx, workspaceSelfParties, [{ side, ...stamped }]);
    }
    const written = await selfPartyRows(tx);
    const after = bySide(written, ({ row }) => row);
    const entity = { entityType: 'self_parties', entityId: tenant.workspaceId };
    await audit.write({ action: 'self_parties.update', ...entity, before, after });
    return success(toDto(written));
  });
}
