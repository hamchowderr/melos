'use server';

import { resolveWorkspaceAction } from '@/app/workspace-action';
import type { GeneratedReportDTO, ReportPreviewDTO, ReportPreviewInput } from '@/lib/dto/reports';
import { generateReport } from '@/server/services/reports/generate';
import { previewReport } from '@/server/services/reports/preview';
import type { ServiceResult } from '@/server/services/service-result';

/** A report action's value, or the refusal code. */
export type ReportActionResult<T> = { ok: true; value: T } | { ok: false; code: string };

const outcome = <T>(result: ServiceResult<T>): ReportActionResult<T> =>
  result.ok ? { ok: true, value: result.value } : { ok: false, code: result.error.code };

async function tenant() {
  const workspace = await resolveWorkspaceAction();
  return workspace.status === 'ready' ? workspace.tenant : null;
}

/** The live text for the chosen songs and sections (RPT-001, RPT-002, RPT-005); report:read. */
export async function previewReportText(
  input: ReportPreviewInput,
): Promise<ReportActionResult<ReportPreviewDTO>> {
  const member = await tenant();
  return member ? outcome(await previewReport(member, input)) : { ok: false, code: 'NO_TENANT' };
}

/** Stores the preview as an immutable text snapshot (RPT-003); report:generate. */
export async function saveReportSnapshot(
  input: ReportPreviewInput,
): Promise<ReportActionResult<GeneratedReportDTO>> {
  const member = await tenant();
  return member
    ? outcome(await generateReport(member, { ...input, format: 'text' }))
    : { ok: false, code: 'NO_TENANT' };
}
