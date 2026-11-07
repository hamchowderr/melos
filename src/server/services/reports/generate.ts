import { asc, eq } from 'drizzle-orm';
import { ulid } from 'ulid';
import type {
  GeneratedReportDTO,
  GenerateReportInput,
  ReportItemDTO,
  ReportSection,
} from '../../../lib/dto/reports';
import {
  generatedReportItems,
  generatedReports,
  pitches,
} from '../../db/schema/workspace.generated';
import { workspaceIntegrityGuard as guard } from '../integrity-guard';
import { requirePermission } from '../permissions';
import { failure, type ServiceResult, success } from '../service-result';
import type { TenantContext } from '../tenant-context';
import { getWorkspaceDatabase, sanitized } from '../workspace-connections';
import { runWorkspaceWrite, type WriteOrigin } from '../workspace-write';
import { buildReport } from './preview';

type ReportRow = typeof generatedReports.$inferSelect;
type ItemRow = typeof generatedReportItems.$inferSelect;

const dtoOf = (row: ReportRow, items: ItemRow[]): GeneratedReportDTO => {
  const content = JSON.parse(row.contentJson) as { items: ReportItemDTO[] };
  const config = JSON.parse(row.configSnapshotJson) as { sections: ReportSection[] };
  return {
    ...{ reportId: row.id, templateId: row.templateId, pitchId: row.pitchId },
    // The rows store each song by one id; content_json keeps both ids it resolved to.
    items: content.items.slice(0, items.length),
    ...{ sections: config.sections, generatedAt: row.generatedAt, text: row.contentText },
    pdfAssetId: row.pdfAssetId,
  };
};

/**
 * generateReport (§3.3, §6.9, §7.7, RPT-003, RPT-005): previewReport's build, stored as one
 * immutable generated_reports row with its config and content snapshots and one
 * generated_report_items row per song in order, audited as report.generate. Only `format: text`
 * for now; text_and_pdf is VALIDATION until PDF output lands. report:generate.
 */
export async function generateReport(
  tenant: TenantContext,
  input: GenerateReportInput,
  origin: WriteOrigin = { type: 'user' },
): Promise<ServiceResult<GeneratedReportDTO>> {
  if (!requirePermission(tenant, { report: ['generate'] }).ok) return failure('FORBIDDEN');
  const format = input.format ?? 'text';
  if (format !== 'text')
    return failure({
      code: 'VALIDATION',
      field: 'format',
      reason: format === 'text_and_pdf' ? 'pdf_unavailable' : 'invalid',
    });
  const built = await buildReport(tenant, input);
  if (!built.ok) return built;
  const { templateId, items, sections, text, songs } = built.value;
  const pitchId = input.pitchId ?? null;
  return runWorkspaceWrite(
    tenant,
    { report: ['generate'] },
    async (tx, audit) => {
      if (pitchId && !(await tx.select().from(pitches).where(eq(pitches.id, pitchId))).length)
        return failure('NOT_FOUND');
      const at = new Date().toISOString();
      const row: ReportRow = {
        ...{ id: `rpt_${ulid()}`, templateId, pitchId },
        configSnapshotJson: JSON.stringify({ sections, format }),
        contentText: text,
        contentJson: JSON.stringify({ items, songs }),
        ...{ pdfAssetId: null, generatedAt: at, generatedBy: tenant.userId },
      };
      const itemRows: ItemRow[] = items.map((item, sortOrder) => ({
        ...{ reportId: row.id, sortOrder },
        // A song is stored by its recording, or by its composition when it has none (P-37).
        recordingId: item.recordingId,
        compositionId: item.recordingId ? null : item.compositionId,
      }));
      await guard.insert(tx, generatedReports, [row]);
      await guard.insert(tx, generatedReportItems, itemRows);
      await audit.write({
        ...{ action: 'report.generate', entityType: 'generated_report', entityId: row.id },
        ...{ before: null, after: { ...row, items: itemRows } },
      });
      return success(dtoOf(row, itemRows));
    },
    origin,
  );
}

/** A stored snapshot as it was generated (RPT-003). report:read; another workspace's is NOT_FOUND. */
export async function getGeneratedReport(
  tenant: TenantContext,
  reportId: string,
): Promise<ServiceResult<GeneratedReportDTO>> {
  if (!requirePermission(tenant, { report: ['read'] }).ok) return failure('FORBIDDEN');
  const [row, items] = await sanitized(tenant.workspaceId, async () => {
    const database = await getWorkspaceDatabase(tenant.workspaceId);
    return Promise.all([
      database.select().from(generatedReports).where(eq(generatedReports.id, reportId)),
      database
        .select()
        .from(generatedReportItems)
        .where(eq(generatedReportItems.reportId, reportId))
        .orderBy(asc(generatedReportItems.sortOrder)),
    ]);
  });
  return row[0] ? success(dtoOf(row[0], items)) : failure('NOT_FOUND');
}
