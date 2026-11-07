import { createTool } from '@mastra/core/tools';
import {
  LIST_REPORT_TEMPLATES_TOOL_NAME,
  listReportTemplatesInputSchema,
  PREVIEW_REPORT_TOOL_NAME,
  previewReportInputSchema,
} from '../../lib/agent/report-tools';
import { toolResultSchema } from '../../lib/agent/tool-result';
import type {
  GeneratedReportDTO,
  ReportPreviewDTO,
  ReportSection,
  ReportTemplateSummary,
} from '../../lib/dto/reports';
import { previewReport } from '../../server/services/reports/preview';
import { listReportTemplates } from '../../server/services/reports/templates';
import { modelOutput, runTool } from './run-tool';

const enabledOf = (sections: ReportSection[]) =>
  sections.filter((section) => section.enabled).map((section) => section.id);

/** listReportTemplates's §3.6 model fields. */
export const summarizeTemplates = (templates: ReportTemplateSummary[]) =>
  templates.map(({ templateId, name, presetKey }) => ({ templateId, name, presetKey }));

/** A report's §3.6 model fields: ids, enabled sections and the length, never the text. */
export const summarizeReport = (report: ReportPreviewDTO | GeneratedReportDTO) => ({
  ...('reportId' in report ? { reportId: report.reportId } : {}),
  templateId: report.templateId,
  items: report.items,
  enabledSections: enabledOf(report.sections),
  characterCount: report.text.length,
});

export const listReportTemplatesTool = createTool({
  id: LIST_REPORT_TEMPLATES_TOOL_NAME,
  description: 'The report templates: the four presets and any saved ones, with their sections.',
  inputSchema: listReportTemplatesInputSchema,
  outputSchema: toolResultSchema<ReportTemplateSummary[]>(),
  execute: ({ reportType }, context) =>
    runTool(context, (tenant) => listReportTemplates(tenant, reportType)),
  toModelOutput: modelOutput(summarizeTemplates),
});

export const previewReportTool = createTool({
  id: PREVIEW_REPORT_TOOL_NAME,
  description:
    'Show a text report (song sheet) for one or more songs from a preset (full, sans_lyrics, just_lyrics, disco_track_info) or template. Saves nothing; the member sees the text, you see only its length.',
  inputSchema: previewReportInputSchema,
  outputSchema: toolResultSchema<ReportPreviewDTO>(),
  execute: (input, context) => runTool(context, (tenant) => previewReport(tenant, input)),
  toModelOutput: modelOutput(summarizeReport),
});
