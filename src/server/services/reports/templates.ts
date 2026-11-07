import { asc, desc, eq } from 'drizzle-orm';
import {
  REPORT_SECTIONS,
  type ReportPreviewInput,
  type ReportSection,
  type ReportSectionId,
  type ReportTemplateSummary,
} from '../../../lib/dto/reports';
import { reportTemplates } from '../../db/schema/workspace.generated';
import { requirePermission } from '../permissions';
import { failure, type ServiceResult, success } from '../service-result';
import type { TenantContext } from '../tenant-context';
import { getWorkspaceDatabase, sanitized, type WorkspaceDatabase } from '../workspace-connections';

type TemplateRow = typeof reportTemplates.$inferSelect;

/** A template's sections in §6.12 order; a section its config leaves out is off. */
export function sectionsOf(configJson: string): ReportSection[] {
  const config = JSON.parse(configJson) as { sections?: { id: string; enabled: boolean }[] };
  const on = new Set(config.sections?.filter((s) => s.enabled).map((s) => s.id));
  return REPORT_SECTIONS.map((id) => ({ id, enabled: on.has(id) }));
}

const summaryOf = (row: TemplateRow): ReportTemplateSummary => ({
  ...{ templateId: row.id, name: row.name, reportType: row.reportType },
  ...{
    presetKey: row.presetKey,
    isSystem: row.isSystem === 1,
    sections: sectionsOf(row.configJson),
  },
});

/** listReportTemplates (§3.3, RPT-001): system presets first, then by name. report:read. */
export async function listReportTemplates(
  tenant: TenantContext,
  reportType?: string,
): Promise<ServiceResult<ReportTemplateSummary[]>> {
  if (!requirePermission(tenant, { report: ['read'] }).ok) return failure('FORBIDDEN');
  const rows = await sanitized(tenant.workspaceId, async () => {
    const database = await getWorkspaceDatabase(tenant.workspaceId);
    return database
      .select()
      .from(reportTemplates)
      .where(reportType ? eq(reportTemplates.reportType, reportType) : undefined)
      .orderBy(desc(reportTemplates.isSystem), asc(reportTemplates.name));
  });
  return success(rows.map(summaryOf));
}

/**
 * The template `input` names, by id or preset key, with its section overrides applied. Exactly one
 * of `templateId` and `preset` (VALIDATION); an unknown section is VALIDATION; no row is NOT_FOUND.
 */
export async function resolveTemplate(
  database: WorkspaceDatabase,
  input: Pick<ReportPreviewInput, 'templateId' | 'preset' | 'sections'>,
): Promise<ServiceResult<{ templateId: string; sections: ReportSection[] }>> {
  if (Boolean(input.templateId) === Boolean(input.preset))
    return failure({
      code: 'VALIDATION',
      field: 'templateId',
      reason: 'exactly_one_of_template_id_or_preset',
    });
  const overrides = Object.entries(input.sections ?? {});
  if (
    overrides.some(
      ([id, on]) => !REPORT_SECTIONS.includes(id as ReportSectionId) || typeof on !== 'boolean',
    )
  )
    return failure({ code: 'VALIDATION', field: 'sections', reason: 'unknown_section' });
  const where = input.templateId
    ? eq(reportTemplates.id, input.templateId)
    : eq(reportTemplates.presetKey, input.preset as string);
  const [row] = await database.select().from(reportTemplates).where(where);
  if (!row) return failure('NOT_FOUND');
  const sections = sectionsOf(row.configJson).map((section) => ({
    id: section.id,
    enabled: input.sections?.[section.id] ?? section.enabled,
  }));
  return success({ templateId: row.id, sections });
}
