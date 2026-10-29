import { and, asc, eq, isNull, ne } from 'drizzle-orm';
import { monotonicFactory, ulid } from 'ulid';
import type { WorkspacePermissions } from '../../../lib/auth/permissions';
import {
  LINK_TYPES,
  type MusicWorkspaceDTO,
  type RecordingDuplicate,
  type RecordingInput,
  type RecordingLinkInput,
  type RecordingPatch,
} from '../../../lib/dto/catalog';
import { normalizeIsrc } from '../../../lib/identifiers';
import { compositions, recordingLinks, recordings } from '../../db/schema/workspace.generated';
import { workspaceIntegrityGuard as guard } from '../integrity-guard';
import { requirePermission } from '../permissions';
import { failure, type ServiceResult, success } from '../service-result';
import type { TenantContext } from '../tenant-context';
import { getWorkspaceDatabase, sanitized } from '../workspace-connections';
import { runWorkspaceWrite, type WorkspaceTransaction } from '../workspace-write';
import { getMusicWorkspace } from './music-workspace';
import { normalizeTitle } from './read';
import { reindexRecording, reindexSong } from './search-index';

const CREATE: WorkspacePermissions = { catalog: ['create'] };
const UPDATE: WorkspacePermissions = { catalog: ['update'] };

const refuse = (field: string, reason: string) => failure({ code: 'VALIDATION', field, reason });
const whole = (value: number | null | undefined) =>
  value == null || (Number.isInteger(value) && value >= 0);

/**
 * Live recordings that hold the ISRC `isrc` normalizes to, or that share the composition, title
 * (normalizeTitle, §3.5) and version title: the §3.3 createRecording approval trigger (§6.15).
 * catalog:read (§6.2); a refused role never opens the database. One query.
 */
export async function findRecordingDuplicates(
  tenant: TenantContext,
  query: Pick<RecordingInput, 'compositionId' | 'title' | 'versionTitle' | 'isrc'>,
): Promise<ServiceResult<RecordingDuplicate[]>> {
  if (!requirePermission(tenant, { catalog: ['read'] }).ok) return failure('FORBIDDEN');
  const normalized = query.isrc ? normalizeIsrc(query.isrc) : undefined;
  const sameIsrc = normalized?.ok ? normalized.value : undefined;
  const rows = await sanitized(tenant.workspaceId, async () => {
    const database = await getWorkspaceDatabase(tenant.workspaceId);
    const { id: recordingId, compositionId, title, versionTitle, isrc } = recordings;
    return database
      .select({ recordingId, compositionId, title, versionTitle, isrc })
      .from(recordings)
      .where(isNull(recordings.deletedAt))
      .orderBy(asc(recordingId));
  });
  const version = (value?: string | null) => normalizeTitle(value ?? '');
  return success(
    rows.flatMap((row) => {
      const sameTake =
        row.compositionId === (query.compositionId ?? null) &&
        normalizeTitle(row.title) === normalizeTitle(query.title) &&
        version(row.versionTitle) === version(query.versionTitle);
      const matchedOn = [
        ...(row.isrc !== null && row.isrc === sameIsrc ? (['isrc'] as const) : []),
        ...(sameTake ? (['title'] as const) : []),
      ];
      return matchedOn.length ? [{ ...row, matchedOn }] : [];
    }),
  );
}

/** VALIDATION for the first broken field, before the database opens. */
function invalid(fields: RecordingPatch, create: boolean): ServiceResult<never> | null {
  if ((create || fields.title !== undefined) && !fields.title?.trim())
    return refuse('title', 'required');
  if (!whole(fields.durationMs)) return refuse('durationMs', 'not_a_whole_number');
  if (!whole(fields.previewStartMs)) return refuse('previewStartMs', 'not_a_whole_number');
  if (fields.bpm != null && !(Number.isFinite(fields.bpm) && fields.bpm > 0))
    return refuse('bpm', 'not_positive');
  const links = fields.links ?? [];
  if (links.some(({ url }) => !url?.trim())) return refuse('links', 'required');
  if (links.some(({ linkType }) => linkType !== undefined && !LINK_TYPES.includes(linkType)))
    return refuse('links', 'unknown_link_type');
  if (links.filter(({ isPrimary }) => isPrimary).length > 1)
    return refuse('links', 'more_than_one_primary');
  return null;
}

/** The recording columns a patch sets, besides isrc and compositionId; undefined keeps a column. */
const columns = (fields: RecordingPatch) => ({
  ...{
    title: fields.title?.trim(),
    versionTitle: fields.versionTitle,
    durationMs: fields.durationMs,
  },
  ...{ bpm: fields.bpm, musicalKey: fields.musicalKey, previewStartMs: fields.previewStartMs },
});

/** A link set as stored and compared: trimmed, with its defaults, in input order. */
const linksOf = (links: RecordingLinkInput[]) =>
  links.map(({ url, linkType = 'private_player', label = null, isPrimary = false }) => ({
    ...{ linkType, label, url: url.trim(), isPrimary: isPrimary ? 1 : 0 },
  }));

/**
 * The isrc to store: the normalized input, null for none, or INVALID_ISRC. A live recording other
 * than `self` holding it is CONFLICT, before uq_recordings_isrc refuses the write.
 */
async function isrcOf(tx: WorkspaceTransaction, input: string | null, self?: string) {
  if (input === null) return success(null);
  const normalized = normalizeIsrc(input);
  if (!normalized.ok) return failure({ ...normalized.error, field: 'isrc' });
  const same = [eq(recordings.isrc, normalized.value), isNull(recordings.deletedAt)];
  const live = and(...same, ...(self ? [ne(recordings.id, self)] : []));
  const [taken] = await tx.select({ id: recordings.id }).from(recordings).where(live).limit(1);
  return taken ? failure({ code: 'CONFLICT', field: 'isrc' }) : success(normalized.value);
}

/** Whether `compositionId` names a live composition in this workspace. */
async function liveComposition(tx: WorkspaceTransaction, compositionId: string) {
  const live = and(eq(compositions.id, compositionId), isNull(compositions.deletedAt));
  return (await tx.select({ id: compositions.id }).from(compositions).where(live)).length > 0;
}

/** A live recording row and its links in stored order, read in the write transaction. */
async function load(tx: WorkspaceTransaction, id: string) {
  const live = and(eq(recordings.id, id), isNull(recordings.deletedAt));
  const [row] = await tx.select().from(recordings).where(live);
  if (!row) return undefined;
  const { linkType, label, url, isPrimary } = recordingLinks;
  const links = await tx
    .select({ linkType, label, url, isPrimary })
    .from(recordingLinks)
    .where(eq(recordingLinks.recordingId, id))
    .orderBy(asc(recordingLinks.id));
  return { ...row, links };
}

/** Stores `links` as the recording's whole set; monotonic `lnk_` ulids keep the input order. */
async function replaceLinks(
  tx: WorkspaceTransaction,
  tenant: TenantContext,
  recordingId: string,
  links: ReturnType<typeof linksOf>,
) {
  await guard.delete(tx, recordingLinks, eq(recordingLinks.recordingId, recordingId));
  const [next, createdAt, createdBy] = [
    monotonicFactory(),
    new Date().toISOString(),
    tenant.userId,
  ];
  const rows = links.map((link) => ({
    id: `lnk_${next()}`,
    recordingId,
    ...link,
    createdAt,
    createdBy,
  }));
  if (rows.length) await guard.insert(tx, recordingLinks, rows);
}

/**
 * Reindexes the songs a write touched: each composition, or the recording's own row when one side
 * has none. Its own row is rebuilt first, so a song reindexed after it keeps the recording's row.
 */
async function reindex(tx: WorkspaceTransaction, id: string, songs: (string | null)[]) {
  if (songs.includes(null)) await reindexRecording(tx, id);
  for (const song of new Set(songs)) if (song) await reindexSong(tx, song);
}

/** The song as getMusicWorkspace reads it after the write commits. */
const songOf = (tenant: TenantContext, entityId: string) =>
  getMusicWorkspace(tenant, { entityType: 'recording', entityId });

/**
 * Creates a recording with its links (CAT-002, CAT-005, §3.3) in one audited write transaction and
 * reindexes its song (§4.3). catalog:create (§6.2) and VALIDATION come first, before the database
 * opens; a composition with no live row is NOT_FOUND; then INVALID_ISRC or CONFLICT. Audits
 * recording.create with the row and its links (§6.6), then returns the song's MusicWorkspaceDTO.
 */
export async function createRecording(
  tenant: TenantContext,
  input: RecordingInput,
): Promise<ServiceResult<MusicWorkspaceDTO>> {
  if (!requirePermission(tenant, CREATE).ok) return failure('FORBIDDEN');
  const refused = invalid(input, true);
  if (refused) return refused;
  const written = await runWorkspaceWrite(tenant, CREATE, async (tx, audit) => {
    const compositionId = input.compositionId ?? null;
    if (compositionId && !(await liveComposition(tx, compositionId))) return failure('NOT_FOUND');
    const isrc = await isrcOf(tx, input.isrc ?? null);
    if (!isrc.ok) return isrc;
    const [id, at] = [`rec_${ulid()}`, new Date().toISOString()];
    await guard.insert(tx, recordings, [
      {
        ...{ id, compositionId, ...columns(input), title: input.title.trim(), isrc: isrc.value },
        ...{ createdAt: at, updatedAt: at, createdBy: tenant.userId, updatedBy: tenant.userId },
      },
    ]);
    await replaceLinks(tx, tenant, id, linksOf(input.links ?? []));
    await reindex(tx, id, [compositionId]);
    const created = await load(tx, id);
    if (!created) throw new Error(`Recording ${id} was not stored`);
    await audit.write({
      ...{ action: 'recording.create', entityType: 'recording', entityId: id },
      ...{ before: null, after: created },
    });
    return success(id);
  });
  return written.ok ? songOf(tenant, written.value) : written;
}

/**
 * Applies `patch` to a live recording (CAT-002, CAT-004, CAT-005, §3.3) in one audited write
 * transaction and reindexes the songs it touched (§4.3). catalog:update (§6.2) and VALIDATION come
 * first; a recording or target composition with no live row is NOT_FOUND; then INVALID_ISRC or
 * CONFLICT for a changed ISRC. A move the song-level pitch rule forbids is SONG_LEVEL_CONFLICT
 * (§4.4 rule 3). `links` replaces the set. A patch that changes nothing writes nothing and adds no
 * audit row; otherwise audits recording.update before and after (§6.6).
 */
export async function updateRecording(
  tenant: TenantContext,
  recordingId: string,
  patch: RecordingPatch,
): Promise<ServiceResult<MusicWorkspaceDTO>> {
  if (!requirePermission(tenant, UPDATE).ok) return failure('FORBIDDEN');
  const refused = invalid(patch, false);
  if (refused) return refused;
  const written = await runWorkspaceWrite(tenant, UPDATE, async (tx, audit) => {
    const before = await load(tx, recordingId);
    if (!before) return failure('NOT_FOUND');
    const set: Partial<typeof recordings.$inferInsert> = columns(patch);
    if (patch.compositionId !== undefined) {
      const target = patch.compositionId;
      if (target && target !== before.compositionId && !(await liveComposition(tx, target)))
        return failure('NOT_FOUND');
      set.compositionId = target;
    }
    if (patch.isrc !== undefined) {
      const isrc = await isrcOf(tx, patch.isrc, recordingId);
      if (!isrc.ok) return isrc;
      set.isrc = isrc.value;
    }
    const keys = Object.keys(set) as (keyof typeof set)[];
    const changed = keys.filter((key) => set[key] !== undefined && set[key] !== before[key]);
    const links = patch.links && linksOf(patch.links);
    const relinked = links && JSON.stringify(links) !== JSON.stringify(before.links);
    if (!changed.length && !relinked) return success(recordingId);
    const stamp = { updatedAt: new Date().toISOString(), updatedBy: tenant.userId };
    const fields = Object.fromEntries(changed.map((key) => [key, set[key]]));
    await guard.update(tx, recordings, { ...fields, ...stamp }, eq(recordings.id, recordingId));
    if (relinked) await replaceLinks(tx, tenant, recordingId, links);
    const after = await load(tx, recordingId);
    if (!after) throw new Error(`Recording ${recordingId} was not stored`);
    // A move reindexes both songs: the old song's row still lists the moved recording's artists.
    await reindex(tx, recordingId, [before.compositionId, after.compositionId]);
    await audit.write({
      ...{ action: 'recording.update', entityType: 'recording', entityId: recordingId },
      ...{ before, after },
    });
    return success(recordingId);
  });
  return written.ok ? songOf(tenant, written.value) : written;
}
