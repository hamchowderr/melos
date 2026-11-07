import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { GeneratedReportDTO, ReportPreviewDTO } from '../../src/lib/dto/reports';
import { summarizeReport, summarizeTemplates } from '../../src/mastra/tools/reports';

const { fixtures } = JSON.parse(readFileSync('fixtures/agui/reports.json', 'utf8')) as {
  fixtures: { toolName: string; result: { value: unknown } }[];
};
const value = (toolName: string) => fixtures.find((f) => f.toolName === toolName)?.result.value;
const ENABLED = ['core', 'rights', 'creators', 'composition', 'recording', 'metadata', 'listen'];

describe('melos-ajt.16: report tools model output (§3.6)', () => {
  it('previewReport gives ids, enabled sections and a character count, never the text', () => {
    const report = value('previewReport') as ReportPreviewDTO;
    const model = summarizeReport(report);
    expect(JSON.stringify(model)).not.toContain('Mock Writer');
    expect(model).toEqual({
      templateId: 'tpl_AGUI_SANS',
      items: [{ recordingId: 'rec_AGUI1', compositionId: 'cmp_AGUI1' }],
      enabledSections: [...ENABLED, 'licensing'],
      characterCount: report.text.length,
    });
  });

  it('generateReport adds the reportId; templates give id, name and preset', () => {
    const saved = summarizeReport(value('generateReport') as GeneratedReportDTO);
    expect(saved).toMatchObject({ reportId: 'rpt_AGUI1', templateId: 'tpl_AGUI_SANS' });
    expect(JSON.stringify(saved)).not.toContain('Harbor');
    expect(summarizeTemplates(value('listReportTemplates') as never)[0]).toEqual({
      templateId: 'tpl_AGUI_FULL',
      name: 'Full',
      presetKey: 'full',
    });
  });
});
