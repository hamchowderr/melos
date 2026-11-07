'use client';

import { useRenderTool } from '@copilotkit/react-core/v2';
import { useState } from 'react';
import { ToolCard } from '@/components/chat/tool-card';
import { renderResult } from '@/components/chat/tool-renderers';
import { Button } from '@/components/ui/button';
import {
  GENERATE_REPORT_TOOL_NAME,
  generateReportInputSchema,
  LIST_REPORT_TEMPLATES_TOOL_NAME,
  listReportTemplatesInputSchema,
  PREVIEW_REPORT_TOOL_NAME,
  previewReportInputSchema,
} from '@/lib/agent/report-tools';
import type {
  GeneratedReportDTO,
  ReportPreviewDTO,
  ReportSection,
  ReportTemplateSummary,
} from '@/lib/dto/reports';

const words = (id: string) => id.replace(/_/g, ' ');
const enabled = (sections: ReportSection[]) =>
  sections.filter((section) => section.enabled).map((section) => words(section.id));

/** ReportTemplateList (§3.3): each template with its enabled sections. */
export function ReportTemplateList({ templates }: { templates: ReportTemplateSummary[] }) {
  return (
    <ToolCard title="Report Templates">
      <ul aria-label="Template List" className="flex flex-col">
        {templates.map((template) => (
          <li key={template.templateId} className="px-4 py-2 odd:bg-muted/30">
            <p className="font-medium">
              {template.name}
              {template.isSystem ? (
                <span className="ml-2 text-xs font-normal text-muted-foreground">preset</span>
              ) : null}
            </p>
            <p className="text-xs text-muted-foreground">{enabled(template.sections).join(', ')}</p>
          </li>
        ))}
      </ul>
    </ToolCard>
  );
}

/** ReportPreview (§3.3, RPT-001, RPT-002): the text first, with copy; a snapshot says so. */
export function ReportPreview({ report }: { report: ReportPreviewDTO | GeneratedReportDTO }) {
  const [copied, setCopied] = useState(false);
  const snapshot = 'reportId' in report;
  const copy = async () => {
    await navigator.clipboard?.writeText(report.text);
    setCopied(true);
  };
  return (
    <ToolCard title={snapshot ? 'Saved Report' : 'Report Preview'}>
      <div className="flex items-center gap-3 px-4 pb-2 text-xs text-muted-foreground">
        <span className="flex-1">
          {report.items.length === 1 ? '1 song' : `${report.items.length} songs`} ·{' '}
          {enabled(report.sections).join(', ')}
          {snapshot ? ` · saved ${report.generatedAt.slice(0, 10)}` : ''}
        </span>
        <Button size="sm" variant="secondary" onClick={copy}>
          {copied ? 'Copied' : 'Copy Text'}
        </Button>
      </div>
      <section aria-label="Report Text" className="mx-4 mb-3">
        <pre className="max-h-96 overflow-auto rounded-lg bg-muted/40 p-3 font-sans text-xs whitespace-pre-wrap">
          {report.text}
        </pre>
      </section>
    </ToolCard>
  );
}

/** Registers the report tools' renderers (§3.3); called by useMelosToolRenderers. */
export function useReportToolRenderers() {
  useRenderTool(
    {
      name: LIST_REPORT_TEMPLATES_TOOL_NAME,
      parameters: listReportTemplatesInputSchema,
      render: renderResult<ReportTemplateSummary[]>('Reading the templates...', (templates) => (
        <ReportTemplateList templates={templates} />
      )),
    },
    [],
  );
  useRenderTool(
    {
      name: PREVIEW_REPORT_TOOL_NAME,
      parameters: previewReportInputSchema,
      render: renderResult<ReportPreviewDTO>('Building the report...', (report) => (
        <ReportPreview report={report} />
      )),
    },
    [],
  );
  useRenderTool(
    {
      name: GENERATE_REPORT_TOOL_NAME,
      parameters: generateReportInputSchema,
      render: renderResult<GeneratedReportDTO>('Saving the report...', (report) => (
        <ReportPreview report={report} />
      )),
    },
    [],
  );
}
