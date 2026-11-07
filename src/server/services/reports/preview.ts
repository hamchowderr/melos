import { inArray } from 'drizzle-orm';
import {
  MAX_REPORT_ITEMS,
  type ReportItemDTO,
  type ReportPreviewDTO,
  type ReportPreviewInput,
  type ReportSection,
} from '../../../lib/dto/reports';
import { compositions } from '../../db/schema/workspace.generated';
import { getMusicWorkspace } from '../catalog/music-workspace';
import { requirePermission } from '../permissions';
import { failure, type ServiceResult, success } from '../service-result';
import type { TenantContext } from '../tenant-context';
import { getWorkspaceDatabase, sanitized } from '../workspace-connections';
import { type ReportSong, renderReport } from './render';
import { resolveTemplate } from './templates';

/** What previewReport and generateReport share: the template, the resolved songs and the text. */
export type BuiltReport = ReportPreviewDTO & { songs: ReportSong[] };

/**
 * Builds a report from canonical data (§7.7): the template's sections with overrides, each item's
 * song from getMusicWorkspace (readiness from RightsService) and its lyrics. A composition item
 * shows its primary recording, or composition sections only without one (P-37). Writes nothing.
 */
export async function buildReport(
  tenant: TenantContext,
  input: ReportPreviewInput,
): Promise<ServiceResult<BuiltReport>> {
  if (!requirePermission(tenant, { report: ['read'] }).ok) return failure('FORBIDDEN');
  const { items } = input;
  if (!Array.isArray(items) || items.length < 1 || items.length > MAX_REPORT_ITEMS)
    return failure({ code: 'VALIDATION', field: 'items', reason: 'one_to_fifty' });
  if (items.some((item) => Boolean(item.recordingId) === Boolean(item.compositionId)))
    return failure({
      code: 'VALIDATION',
      field: 'items',
      reason: 'exactly_one_of_recording_or_composition',
    });
  const database = await sanitized(tenant.workspaceId, () =>
    getWorkspaceDatabase(tenant.workspaceId),
  );
  const template = await sanitized(tenant.workspaceId, () => resolveTemplate(database, input));
  if (!template.ok) return template;
  const songs: ReportSong[] = [];
  for (const item of items) {
    const focus = item.recordingId
      ? { entityType: 'recording' as const, entityId: item.recordingId }
      : { entityType: 'composition' as const, entityId: item.compositionId as string };
    const song = await getMusicWorkspace(tenant, focus);
    if (!song.ok) return song;
    const recordingId = item.recordingId ?? song.value.primaryRecordingId;
    songs.push({ song: song.value, recordingId, lyrics: null });
  }
  const compositionIds = [
    ...new Set(songs.flatMap(({ song }) => (song.composition ? [song.composition.id] : []))),
  ];
  const rows = compositionIds.length
    ? await sanitized(tenant.workspaceId, () =>
        database
          .select({ id: compositions.id, lyrics: compositions.lyrics })
          .from(compositions)
          .where(inArray(compositions.id, compositionIds)),
      )
    : [];
  const lyrics = new Map(rows.map((row) => [row.id, row.lyrics]));
  for (const song of songs) song.lyrics = lyrics.get(song.song.composition?.id ?? '') ?? null;
  const { sections } = template.value;
  const reportItems: ReportItemDTO[] = songs.map(({ song, recordingId }) => ({
    recordingId,
    compositionId: song.composition?.id ?? null,
  }));
  return success({
    templateId: template.value.templateId,
    items: reportItems,
    sections,
    text: renderReport(songs, enabledOf(sections)),
    songs,
  });
}

const enabledOf = (sections: ReportSection[]) =>
  new Set(sections.filter((section) => section.enabled).map((section) => section.id));

/** previewReport (§3.3, §6.9, RPT-001, RPT-002, RPT-005): live text; persists nothing. report:read. */
export async function previewReport(
  tenant: TenantContext,
  input: ReportPreviewInput,
): Promise<ServiceResult<ReportPreviewDTO>> {
  const built = await buildReport(tenant, input);
  if (!built.ok) return built;
  const { songs: _songs, ...preview } = built.value;
  return success(preview);
}
