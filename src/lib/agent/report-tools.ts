import { z } from 'zod';
import { MAX_REPORT_ITEMS, REPORT_PRESETS, REPORT_SECTIONS } from '../dto/reports';

/** Report tool names and inputs (docs/CONTRACT.md §3.3). Zod only. */
export const LIST_REPORT_TEMPLATES_TOOL_NAME = 'listReportTemplates';
export const PREVIEW_REPORT_TOOL_NAME = 'previewReport';
export const GENERATE_REPORT_TOOL_NAME = 'generateReport';

export const listReportTemplatesInputSchema = z.object({
  reportType: z.string().min(1).optional(),
});

const item = z.object({
  recordingId: z.string().min(1).optional(),
  compositionId: z.string().min(1).optional().describe('Its primary recording is used.'),
});

export const previewReportInputSchema = z.object({
  templateId: z.string().min(1).optional().describe('Give this or preset, not both.'),
  preset: z.enum(REPORT_PRESETS).optional(),
  items: z.array(item).min(1).max(MAX_REPORT_ITEMS).describe('The songs, in report order.'),
  sections: z
    .partialRecord(z.enum(REPORT_SECTIONS), z.boolean())
    .optional()
    .describe('Turn single sections on or off.'),
});

export const generateReportInputSchema = previewReportInputSchema.extend({
  format: z.enum(['text', 'text_and_pdf']).optional().describe('Default text.'),
  pitchId: z.string().min(1).optional().describe('The pitch the report goes with.'),
});
