import { and, asc, eq, inArray, isNull, ne, type SQL } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { WorkspacePermissions } from '../../../lib/auth/permissions';
import type {
  CompositionDuplicate,
  CompositionInput,
  CompositionPatch,
  MusicWorkspaceDTO,
} from '../../../lib/dto/catalog';
import { normalizeIswc } from '../../../lib/identifiers';
import { compositionAltTitles, compositions } from '../../db/schema/workspace.generated';
import { workspaceIntegrityGuard as guard } from '../integrity-guard';
import { requirePermission } from '../permissions';
import { isCalendarDate } from '../rights/agreements';
import { failure, type ServiceResult, success } from '../service-result';
import type { TenantContext } from '../tenant-context';
import { getWorkspaceDatabase, sanitized } from '../workspace-connections';
import { runWorkspaceWrite, type WorkspaceTransaction } from '../workspace-write';
import { getMusicWorkspace } from './music-workspace';
import { normalizeTitle } from './read';
import { reindexSong } from './search-index';

const CREATE: WorkspacePermissions = { catalog: ['create'] };
const UPDATE: WorkspacePermissions = { catalog: ['update'] };

const refuse = (field: string, reason: string) => failure({ code: 'VALIDATION', field, reason });

/**
 * Live compositions whose title normalizes (normalizeTitle, §3.5) to the same text as `title`, or
 * that hold the ISWC `iswc` normalizes to: the §3.3 createComposition approval trigger (§6.15) and
 * the song form's warning. An ISWC normalizeIswc refuses matches nothing, since createComposition
 * refuses it too. catalog:read (§6.2); a refused role never opens the database. One query.
 */
export async function findCompositionDuplicates(
  tenant: TenantContext,
  { title, iswc }: { title: string; iswc?: string | null },
): Promise<ServiceResult<CompositionDuplicate[]>> {
  if (!requirePermission(tenant, { catalog: ['read'] }).ok) return failure('FORBIDDEN');
  const normalized = iswc ? normalizeIswc(iswc) : undefined;
  const sameIswc = normalized?.ok ? normalized.value : undefined;
  const rows = await sanitized(tenant.workspaceId, async () => {
    const database = await getWorkspaceDatabase(tenant.workspaceId);
    const { id: compositionId, title, iswc } = compositions;
    const live = isNull(compositions.deletedAt);
    return database
      .select({ compositionId, title, iswc })
      .from(compositions)
      .where(live)
      .orderBy(asc(compositionId));
  });
  const sameTitle = normalizeTitle(title);
  return success(
    rows.flatMap((row) => {
      const matchedOn = [
        ...(normalizeTitle(row.title) === sameTitle ? (['title'] as const) : []),
        ...(row.iswc !== null && row.iswc === sameIswc ? (['iswc'] as const) : []),
      ];
      return matchedOn.length ? [{ ...row, matchedOn }] : [];
    }),
  );
}

/**
 * VALIDATION for the first broken field, before the database opens: a title that is not blank when
 * given (always on create), a calendar copyright date, and alternate titles that are not blank and
 * appear once each after trimming (the composition_alt_titles key).
 */
function invalid(fields: CompositionPatch, create: boolean): ServiceResult<never> | null {
  if ((create || fields.title !== undefined) && !fields.title?.trim())
    return refuse('title', 'required');
  if (fields.copyrightDate != null && !isCalendarDate(fields.copyrightDate))
    return refuse('copyrightDate', 'not_a_date');
  const alternates = fields.altTitles?.map((title) => title.trim()) ?? [];
  if (alternates.some((title) => !title)) return refuse('altTitles', 'required');
  if (new Set(alternates).size < alternates.length) return refuse('altTitles', 'duplicate_title');
  return null;
}

/** The composition columns a patch sets, besides iswc; undefined keeps a column. */
const columns = (fields: CompositionPatch) => ({
  ...{ title: fields.title?.trim(), description: fields.description, lyrics: fields.lyrics },
  ...{ copyrightRegistrationNumber: fields.copyrightRegistrationNumber },
  copyrightDate: fields.copyrightDate,
});

/**
 * The iswc to store: the normalized input, null for none, or INVALID_ISWC. The check digit is
 * tested only on a new value (D-2: `stored` passes on its shape). A live composition other than
 * `self` holding it is CONFLICT, before uq_compositions_iswc refuses the write (P-46).
 */
async function iswcOf(
  tx: WorkspaceTransaction,
  input: string | null,
  { stored, self }: { stored?: string | null; self?: string } = {},
): Promise<ServiceResult<string | null>> {
  if (input === null) return success(null);
  const normalized = normalizeIswc(input, { stored });
  if (!normalized.ok) return failure({ ...normalized.error, field: 'iswc' });
  const same = [eq(compositions.iswc, normalized.value), isNull(compositions.deletedAt)];
  const live = and(...same, ...(self ? [ne(compositions.id, self)] : []));
  const [taken] = await tx.select({ id: compositions.id }).from(compositions).where(live).limit(1);
  return taken ? failure({ code: 'CONFLICT', field: 'iswc' }) : success(normalized.value);
}

/** A live composition row and its alternate titles, read in the write transaction. */
async function load(tx: WorkspaceTransaction, id: string) {
  const live = and(eq(compositions.id, id), isNull(compositions.deletedAt));
  const [row] = await tx.select().from(compositions).where(live);
  if (!row) return undefined;
  const altTitles = await tx
    .select({ title: compositionAltTitles.title, titleType: compositionAltTitles.titleType })
    .from(compositionAltTitles)
    .where(eq(compositionAltTitles.compositionId, id))
    .orderBy(asc(compositionAltTitles.title));
  return { ...row, altTitles };
}

/** The song as getMusicWorkspace reads it after the write commits. */
const songOf = (tenant: TenantContext, entityId: string) =>
  getMusicWorkspace(tenant, { entityType: 'composition', entityId });

/**
 * Creates a composition with its alternate titles (CAT-001, §3.3) in one audited write transaction
 * and reindexes its catalog_search row (§4.3). catalog:create (§6.2) and VALIDATION come first,
 * before the database opens; then INVALID_ISWC or CONFLICT before any write. Audits
 * composition.create with the row and its alternate titles (§6.6), then returns the song's
 * MusicWorkspaceDTO. A duplicate title is allowed here: findCompositionDuplicates is the §6.15
 * approval trigger, which the agent path checks before it calls this.
 */
export async function createComposition(
  tenant: TenantContext,
  input: CompositionInput,
): Promise<ServiceResult<MusicWorkspaceDTO>> {
  if (!requirePermission(tenant, CREATE).ok) return failure('FORBIDDEN');
  const refused = invalid(input, true);
  if (refused) return refused;
  const written = await runWorkspaceWrite(tenant, CREATE, async (tx, audit) => {
    const iswc = await iswcOf(tx, input.iswc ?? null);
    if (!iswc.ok) return iswc;
    const [id, at] = [`cmp_${ulid()}`, new Date().toISOString()];
    await guard.insert(tx, compositions, [
      {
        ...{ id, ...columns(input), title: input.title.trim(), iswc: iswc.value },
        ...{ createdAt: at, updatedAt: at, createdBy: tenant.userId, updatedBy: tenant.userId },
      },
    ]);
    const titles = (input.altTitles ?? []).map((title) => title.trim());
    if (titles.length)
      await guard.insert(
        tx,
        compositionAltTitles,
        titles.map((title) => ({ id: ulid(), compositionId: id, title })),
      );
    await reindexSong(tx, id);
    const created = await load(tx, id);
    if (!created) throw new Error(`Composition ${id} was not stored`);
    await audit.write({
      ...{ action: 'composition.create', entityType: 'composition', entityId: id },
      ...{ before: null, after: created },
    });
    return success(id);
  });
  return written.ok ? songOf(tenant, written.value) : written;
}

/**
 * Applies `patch` to a live composition (CAT-001, CAT-004, §3.3) in one audited write transaction
 * and reindexes the song (§4.3). catalog:update (§6.2) and VALIDATION come first; a composition with
 * no live row is NOT_FOUND; then INVALID_ISWC or CONFLICT for a changed ISWC. `altTitles` replaces
 * the set, keeping the rows of titles it keeps. A patch that changes nothing writes nothing and adds
 * no audit row. Otherwise audits composition.update with the row and its alternate titles before
 * and after (§6.6), then returns the song's MusicWorkspaceDTO.
 */
export async function updateComposition(
  tenant: TenantContext,
  compositionId: string,
  patch: CompositionPatch,
): Promise<ServiceResult<MusicWorkspaceDTO>> {
  if (!requirePermission(tenant, UPDATE).ok) return failure('FORBIDDEN');
  const refused = invalid(patch, false);
  if (refused) return refused;
  const written = await runWorkspaceWrite(tenant, UPDATE, async (tx, audit) => {
    const before = await load(tx, compositionId);
    if (!before) return failure('NOT_FOUND');
    const set: Partial<typeof compositions.$inferInsert> = columns(patch);
    if (patch.iswc !== undefined) {
      const iswc = await iswcOf(tx, patch.iswc, { stored: before.iswc, self: compositionId });
      if (!iswc.ok) return iswc;
      set.iswc = iswc.value;
    }
    const keys = Object.keys(set) as (keyof typeof set)[];
    const changed = keys.filter((key) => set[key] !== undefined && set[key] !== before[key]);
    const wanted = patch.altTitles?.map((title) => title.trim());
    const had = before.altTitles.map(({ title }) => title);
    const dropped = wanted ? had.filter((title) => !wanted.includes(title)) : [];
    const added = wanted ? wanted.filter((title) => !had.includes(title)) : [];
    if (!changed.length && !dropped.length && !added.length) return success(compositionId);
    const stamp = { updatedAt: new Date().toISOString(), updatedBy: tenant.userId };
    const self = eq(compositions.id, compositionId);
    await guard.update(tx, compositions, { ...set, ...stamp }, self);
    const own = eq(compositionAltTitles.compositionId, compositionId);
    if (dropped.length)
      await guard.delete(
        tx,
        compositionAltTitles,
        and(own, inArray(compositionAltTitles.title, dropped)) as SQL,
      );
    if (added.length)
      await guard.insert(
        tx,
        compositionAltTitles,
        added.map((title) => ({ id: ulid(), compositionId, title })),
      );
    await reindexSong(tx, compositionId);
    const after = await load(tx, compositionId);
    if (!after) throw new Error(`Composition ${compositionId} was not stored`);
    await audit.write({
      ...{ action: 'composition.update', entityType: 'composition', entityId: compositionId },
      ...{ before, after },
    });
    return success(compositionId);
  });
  return written.ok ? songOf(tenant, written.value) : written;
}
