import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { WorkspacePermissions } from '../../../lib/auth/permissions';
import {
  RELEASE_TYPES,
  type ReleaseDTO,
  type ReleaseInput,
  type ReleaseTrackDTO,
  type ReleaseType,
} from '../../../lib/dto/catalog';
import { normalizeUpcEan } from '../../../lib/identifiers';
import { releases, releaseTracks } from '../../db/schema/workspace.generated';
import { workspaceIntegrityGuard as guard } from '../integrity-guard';
import { requirePermission } from '../permissions';
import { isCalendarDate } from '../rights/agreements';
import { failure, type ServiceResult, success } from '../service-result';
import type { TenantContext } from '../tenant-context';
import { getWorkspaceDatabase, sanitized } from '../workspace-connections';
import { runWorkspaceWrite, type WorkspaceTransaction } from '../workspace-write';

const CREATE: WorkspacePermissions = { catalog: ['create'] };

const refuse = (field: string, reason: string) => failure({ code: 'VALIDATION', field, reason });
const positive = (n: unknown) => Number.isInteger(n) && (n as number) >= 1;

type TrackInput = NonNullable<ReleaseInput['tracks']>[number];

/** A track as stored: disc 1 and no track number unless given (§4.2). */
const track = ({ recordingId, discNumber = 1, trackNumber = null }: TrackInput) => ({
  ...{ recordingId, discNumber, trackNumber },
});

/**
 * VALIDATION for the first broken field, before the database opens: a title that is not blank, the
 * §4.2 CHECKs on type and positions, a calendar date, and each recording and numbered position once.
 */
function invalid(fields: ReleaseInput): ServiceResult<never> | null {
  if (!fields.title?.trim()) return refuse('title', 'required');
  if (fields.releaseType != null && !RELEASE_TYPES.includes(fields.releaseType))
    return refuse('releaseType', 'not_allowed');
  if (fields.releaseDate != null && !isCalendarDate(fields.releaseDate))
    return refuse('releaseDate', 'not_a_date');
  const tracks = (fields.tracks ?? []).map(track);
  const placed = (t: ReleaseTrackDTO) => t.trackNumber === null || positive(t.trackNumber);
  if (!tracks.every((t) => positive(t.discNumber) && placed(t)))
    return refuse('tracks', 'not_a_position');
  if (new Set(tracks.map((t) => t.recordingId)).size < tracks.length)
    return refuse('tracks', 'duplicate_recording');
  const numbered = tracks.filter((t) => t.trackNumber !== null);
  if (new Set(numbered.map((t) => `${t.discNumber}.${t.trackNumber}`)).size < numbered.length)
    return refuse('tracks', 'duplicate_position');
  return null;
}

/** The release columns an input sets, besides upc_ean. */
const columns = (fields: ReleaseInput) => ({
  ...{ title: fields.title?.trim(), releaseType: fields.releaseType },
  ...{ labelPartyId: fields.labelPartyId, distributorPartyId: fields.distributorPartyId },
  releaseDate: fields.releaseDate,
});

/**
 * The upc_ean to store (D-1): the normalized input, null for none, or INVALID_UPC_EAN. PROPOSED
 * (melos-rpr.14): a live release with the same GTIN-13, reading a 12-digit UPC-A with a leading
 * zero, is CONFLICT; the value is still stored as normalized.
 */
async function upcEanOf(
  tx: WorkspaceTransaction,
  input: string | null | undefined,
): Promise<ServiceResult<string | null>> {
  if (input == null) return success(null);
  const normalized = normalizeUpcEan(input);
  if (!normalized.ok) return failure({ ...normalized.error, field: 'upcEan' });
  const upc = releases.upcEan;
  const gtin = sql`CASE length(${upc}) WHEN 12 THEN '0' || ${upc} ELSE ${upc} END`;
  const same = sql`${gtin} = ${normalized.value.padStart(13, '0')}`;
  const live = and(same, isNull(releases.deletedAt));
  const [taken] = await tx.select({ id: releases.id }).from(releases).where(live).limit(1);
  return taken ? failure({ code: 'CONFLICT', field: 'upcEan' }) : success(normalized.value);
}

const TRACK = {
  recordingId: releaseTracks.recordingId,
  discNumber: releaseTracks.discNumber,
  trackNumber: releaseTracks.trackNumber,
};

/** A live release and its tracks in DTO order, read in a transaction or as one batch. */
const releaseReads = (db: Pick<WorkspaceTransaction, 'select'>, id: string) =>
  [
    db
      .select()
      .from(releases)
      .where(and(eq(releases.id, id), isNull(releases.deletedAt))),
    db
      .select(TRACK)
      .from(releaseTracks)
      .where(eq(releaseTracks.releaseId, id))
      .orderBy(
        asc(releaseTracks.discNumber),
        sql`${releaseTracks.trackNumber} IS NULL`,
        asc(releaseTracks.trackNumber),
        asc(releaseTracks.recordingId),
      ),
  ] as const;

type Row = typeof releases.$inferSelect;

const toDTO = ([[row], tracks]: readonly [Row[], ReleaseTrackDTO[]]): ReleaseDTO | undefined =>
  row && { ...row, releaseType: row.releaseType as ReleaseType | null, tracks };

async function load(tx: WorkspaceTransaction, id: string) {
  const [row, tracks] = releaseReads(tx, id);
  return toDTO([await row, await tracks]);
}

/**
 * Creates a release with ordered tracks (CAT-007, §3.3) in one audited write transaction (§7.2).
 * catalog:create (§6.2) and VALIDATION come first, before the database opens; then INVALID_UPC_EAN
 * or CONFLICT before any write, and IntegrityGuard's NOT_FOUND, with counts, for a label,
 * distributor or recording with no live row in the tenant's own database (§3.1, §4.4 rule 1).
 * Audits release.create with the release and its tracks (§6.6).
 */
export async function createRelease(
  tenant: TenantContext,
  input: ReleaseInput,
): Promise<ServiceResult<ReleaseDTO>> {
  if (!requirePermission(tenant, CREATE).ok) return failure('FORBIDDEN');
  const refused = invalid(input);
  if (refused) return refused;
  return runWorkspaceWrite(tenant, CREATE, async (tx, audit) => {
    const upcEan = await upcEanOf(tx, input.upcEan);
    if (!upcEan.ok) return upcEan;
    const [id, at] = [`rel_${ulid()}`, new Date().toISOString()];
    await guard.insert(tx, releases, [
      {
        ...{ id, ...columns(input), title: input.title.trim(), upcEan: upcEan.value },
        ...{ createdAt: at, updatedAt: at, createdBy: tenant.userId, updatedBy: tenant.userId },
      },
    ]);
    const tracks = (input.tracks ?? []).map((given) => ({ releaseId: id, ...track(given) }));
    if (tracks.length) await guard.insert(tx, releaseTracks, tracks);
    const created = await load(tx, id);
    if (!created) throw new Error(`Release ${id} was not stored`);
    await audit.write({
      ...{ action: 'release.create', entityType: 'release', entityId: id },
      ...{ before: null, after: created },
    });
    return success(created);
  });
}

/**
 * A live release with its tracks, for catalog:read (§6.2), in one batch. A refused role never opens
 * the database; an id with no live release in the tenant's own database is NOT_FOUND (§3.1).
 */
export async function getRelease(
  tenant: TenantContext,
  releaseId: string,
): Promise<ServiceResult<ReleaseDTO>> {
  if (!requirePermission(tenant, { catalog: ['read'] }).ok) return failure('FORBIDDEN');
  const read = await sanitized(tenant.workspaceId, async () => {
    const database = await getWorkspaceDatabase(tenant.workspaceId);
    return database.batch(releaseReads(database, releaseId));
  });
  const release = toDTO(read);
  return release ? success(release) : failure('NOT_FOUND');
}
