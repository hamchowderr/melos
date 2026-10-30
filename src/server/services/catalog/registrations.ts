import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { WorkspacePermissions } from '../../../lib/auth/permissions';
import {
  COMPOSITION_REGISTRIES,
  type CompositionRegistrationInput,
  type MusicWorkspaceDTO,
  RECORDING_REGISTRIES,
  REGISTRATION_STATUSES,
  type RecordingRegistrationInput,
} from '../../../lib/dto/catalog';
import {
  compositionRegistrations,
  compositions,
  recordingRegistrations,
  recordings,
} from '../../db/schema/workspace.generated';
import { workspaceIntegrityGuard as guard } from '../integrity-guard';
import { requirePermission } from '../permissions';
import { isCalendarDate } from '../rights/agreements';
import { planByNaturalKey } from '../rights/shares';
import { failure, type ServiceResult, success } from '../service-result';
import type { TenantContext } from '../tenant-context';
import { runWorkspaceWrite } from '../workspace-write';
import { getMusicWorkspace } from './music-workspace';
import { COMPOSITION_REGISTRATION, RECORDING_REGISTRATION } from './read';

const UPDATE: WorkspacePermissions = { catalog: ['update'] };

const refuse = (reason: string) => failure({ code: 'VALIDATION', field: 'registrations', reason });
const trimmed = (value: string | null | undefined) => value?.trim() || null;

/**
 * The stored shape of an input row: only the target's columns, defaults applied, text trimmed and a
 * society code uppercased. A code the row leaves out is NULL, because the set replaces the stored one.
 */
type StoredRow = {
  registryKind: string;
  status: string;
  registeredOn: string | null;
  notes: string | null;
  societyCode?: string | null;
  workCode?: string | null;
  registrationCode?: string | null;
};

function normalize(input: Record<string, unknown>, codes: readonly string[]): StoredRow {
  const text = (field: string) => trimmed(input[field] as string | null | undefined);
  const row: Record<string, string | null> = {};
  for (const field of codes)
    row[field] = field === 'societyCode' ? (text(field)?.toUpperCase() ?? null) : text(field);
  return {
    registryKind: input.registryKind as string,
    ...row,
    status: (input.status as string | undefined) ?? 'registered',
    registeredOn: (input.registeredOn as string | null | undefined) ?? null,
    notes: text('notes'),
  };
}

const keyOf = (row: { registryKind: string; societyCode?: string | null }) =>
  `${row.registryKind}|${row.societyCode ?? ''}`;

/** VALIDATION for the first broken row, before the database opens. */
function invalid(rows: StoredRow[], kinds: readonly string[]) {
  for (const row of rows) {
    if (!kinds.includes(row.registryKind)) return refuse('unknown_registry');
    if (!(REGISTRATION_STATUSES as readonly string[]).includes(row.status))
      return refuse('unknown_status');
    if ((row.registryKind === 'pro') !== Boolean(row.societyCode))
      return refuse(row.registryKind === 'pro' ? 'society_required' : 'society_only_for_pro');
    if (row.registeredOn !== null && !isCalendarDate(row.registeredOn)) return refuse('not_a_date');
  }
  if (new Set(rows.map(keyOf)).size < rows.length) return refuse('duplicate_registration');
  return null;
}

type Target = {
  entityType: 'composition' | 'recording';
  table: typeof compositionRegistrations | typeof recordingRegistrations;
  owner: typeof compositions | typeof recordings;
  ownerColumn:
    | typeof compositionRegistrations.compositionId
    | typeof recordingRegistrations.recordingId;
  select: typeof COMPOSITION_REGISTRATION | typeof RECORDING_REGISTRATION;
  kinds: readonly string[];
  codes: readonly string[];
};

const COMPOSITION: Target = {
  entityType: 'composition',
  table: compositionRegistrations,
  owner: compositions,
  ownerColumn: compositionRegistrations.compositionId,
  select: COMPOSITION_REGISTRATION,
  kinds: COMPOSITION_REGISTRIES,
  codes: ['societyCode', 'workCode'],
};

const RECORDING: Target = {
  entityType: 'recording',
  table: recordingRegistrations,
  owner: recordings,
  ownerColumn: recordingRegistrations.recordingId,
  select: RECORDING_REGISTRATION,
  kinds: RECORDING_REGISTRIES,
  codes: ['registrationCode'],
};

/**
 * Replaces a song's whole registration set (CAT-010, §4.4) in one audited write, upserting on
 * (registry, society) so a row in both sets keeps its id. catalog:update (§6.2) and VALIDATION come
 * first, before the database opens; a target with no live row is NOT_FOUND. A set equal to the
 * stored one writes nothing. Returns the song's MusicWorkspaceDTO.
 */
async function replaceRegistrations(
  tenant: TenantContext,
  target: Target,
  entityId: string,
  input: (CompositionRegistrationInput | RecordingRegistrationInput)[],
): Promise<ServiceResult<MusicWorkspaceDTO>> {
  if (!requirePermission(tenant, UPDATE).ok) return failure('FORBIDDEN');
  const rows = input.map((row) => normalize(row, target.codes));
  const refused = invalid(rows, target.kinds);
  if (refused) return refused;
  const { table, owner, ownerColumn, entityType } = target;
  const written = await runWorkspaceWrite(tenant, UPDATE, async (tx, audit) => {
    const live = and(eq(owner.id, entityId), isNull(owner.deletedAt));
    const [found] = await tx.select({ id: owner.id }).from(owner).where(live);
    if (!found) return failure('NOT_FOUND');
    const read = () =>
      tx
        .select(target.select)
        .from(table)
        .where(eq(ownerColumn, entityId))
        .orderBy(asc(table.registryKind), asc(table.id));
    const before = await read();
    const plan = planByNaturalKey(
      before.map((row) => ({ id: row.id, key: keyOf(row) })),
      rows,
      keyOf,
    );
    const held = new Map<string, Record<string, unknown>>(before.map((row) => [row.id, row]));
    const changed = ({ id, row }: (typeof plan.kept)[number]) =>
      Object.entries(row).some(([field, value]) => held.get(id)?.[field] !== value);
    const updates = plan.kept.filter(changed);
    if (!plan.gone.length && !plan.added.length && !updates.length) return success(entityId);
    const [at, by] = [new Date().toISOString(), tenant.userId];
    if (plan.gone.length) await guard.delete(tx, table, inArray(table.id, plan.gone));
    for (const { id, row } of updates)
      await guard.update(tx, table, { ...row, updatedAt: at, updatedBy: by }, eq(table.id, id));
    if (plan.added.length) {
      const stamp = { createdAt: at, updatedAt: at, createdBy: by, updatedBy: by };
      const owned = { [entityType === 'composition' ? 'compositionId' : 'recordingId']: entityId };
      const values = plan.added.map((row) => ({ id: ulid(), ...owned, ...row, ...stamp }));
      await guard.insert(tx, table, values as (typeof table.$inferInsert)[]);
    }
    await audit.write({
      ...{ action: `${entityType}_registrations.replace`, entityType, entityId },
      ...{ before: { registrations: before }, after: { registrations: await read() } },
    });
    return success(entityId);
  });
  return written.ok ? getMusicWorkspace(tenant, { entityType, entityId }) : written;
}

/** Replaces where a composition is registered: its PROs, The MLC, HFA and `other` (CAT-010). */
export const replaceCompositionRegistrations = (
  tenant: TenantContext,
  compositionId: string,
  registrations: CompositionRegistrationInput[],
) => replaceRegistrations(tenant, COMPOSITION, compositionId, registrations);

/** Replaces where a recording is registered: SoundExchange and `other` (CAT-010). */
export const replaceRecordingRegistrations = (
  tenant: TenantContext,
  recordingId: string,
  registrations: RecordingRegistrationInput[],
) => replaceRegistrations(tenant, RECORDING, recordingId, registrations);
