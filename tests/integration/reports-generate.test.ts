import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auditLog,
  generatedReportItems,
  generatedReports,
} from '../../src/server/db/schema/workspace.generated';
import type { ServiceResult } from '../../src/server/services/service-result';
import type { TenantContext } from '../../src/server/services/tenant-context';
import { NORTHSTAR, seedNorthstarTenant } from './catalog-support';
import { prepareWorkspaceServices, withRole } from './workspace-service';

let services: Awaited<ReturnType<typeof prepareWorkspaceServices>>;
let reports: typeof import('../../src/server/services/reports/generate');
let preview: typeof import('../../src/server/services/reports/preview');
let catalog: typeof import('../../src/server/services/catalog/compositions');
let owner: TenantContext;
const k = NORTHSTAR.keys;
const open = () => services.connections.getWorkspaceDatabase(owner.workspaceId);
const rowCount = async () =>
  (
    await (
      await open()
    ).all<{ n: number }>(
      sql`SELECT (SELECT count(*) FROM audit_log) + (SELECT count(*) FROM generated_reports) AS n`,
    )
  )[0].n;
function accepted<T>(result: ServiceResult<T>): T {
  if (!result.ok) throw new Error(`Refused with ${JSON.stringify(result.error)}`);
  return result.value;
}

beforeAll(async () => {
  services = await prepareWorkspaceServices('reports-generate');
  reports = await import('../../src/server/services/reports/generate');
  preview = await import('../../src/server/services/reports/preview');
  catalog = await import('../../src/server/services/catalog/compositions');
  owner = await seedNorthstarTenant();
});
afterAll(async () => {
  if (owner) await services.connections.closeWorkspaceDatabase(owner.workspaceId);
  await services?.close();
});

describe('melos-ajt.11: generateReport snapshots (RPT-003, RPT-005)', () => {
  const input = {
    preset: 'sans_lyrics' as const,
    items: [{ compositionId: k.cmp_OCEAN }, { recordingId: k.rec_MIDNIGHT }],
    pitchId: k.pit_PAPER_REBECCA,
  };

  it('RPT-INT-003: stores one row per song in order, and a later catalog change leaves it', async () => {
    const generated = accepted(await reports.generateReport(withRole(owner, 'member'), input));
    const live = accepted(await preview.previewReport(owner, input));
    expect(generated).toMatchObject({
      ...{ pitchId: k.pit_PAPER_REBECCA, templateId: live.templateId, text: live.text },
      items: [
        { recordingId: k.rec_OCEAN, compositionId: k.cmp_OCEAN },
        { recordingId: k.rec_MIDNIGHT, compositionId: k.cmp_MIDNIGHT },
      ],
      pdfAssetId: null,
    });
    const database = await open();
    const rows = await database
      .select()
      .from(generatedReportItems)
      .where(eq(generatedReportItems.reportId, generated.reportId));
    expect(rows.map((row) => [row.sortOrder, row.recordingId, row.compositionId])).toEqual([
      [0, k.rec_OCEAN, null],
      [1, k.rec_MIDNIGHT, null],
    ]);
    const [audit] = await database
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityId, generated.reportId));
    expect(audit).toMatchObject({ action: 'report.generate', entityType: 'generated_report' });

    accepted(await catalog.updateComposition(owner, k.cmp_OCEAN, { description: 'Retitled pad' }));
    expect(accepted(await preview.previewReport(owner, input)).text).toContain('Retitled pad');
    const stored = accepted(
      await reports.getGeneratedReport(withRole(owner, 'viewer'), generated.reportId),
    );
    expect(stored).toEqual(generated);
    expect(stored.text).not.toContain('Retitled pad');
    const [row] = await database
      .select()
      .from(generatedReports)
      .where(eq(generatedReports.id, generated.reportId));
    expect(JSON.parse(row.configSnapshotJson)).toEqual({
      sections: generated.sections,
      format: 'text',
    });
  });

  it('refuses PDF, an unknown pitch and a role without report:generate, writing nothing', async () => {
    const before = await rowCount();
    const refused = (error: object) => ({ ok: false, error });
    expect(await reports.generateReport(owner, { ...input, format: 'text_and_pdf' })).toEqual(
      refused({ code: 'VALIDATION', field: 'format', reason: 'pdf_unavailable' }),
    );
    expect(await reports.generateReport(owner, { ...input, pitchId: 'pit_missing' })).toEqual(
      refused({ code: 'NOT_FOUND' }),
    );
    expect(await reports.generateReport(withRole(owner, 'viewer'), input)).toEqual(
      refused({ code: 'FORBIDDEN' }),
    );
    expect(await reports.generateReport(owner, { ...input, items: [] })).toEqual(
      refused({ code: 'VALIDATION', field: 'items', reason: 'one_to_fifty' }),
    );
    expect(await reports.getGeneratedReport(owner, 'rpt_missing')).toEqual(
      refused({ code: 'NOT_FOUND' }),
    );
    expect(await rowCount()).toBe(before);
  });

  it('lists snapshots newest first with their song count and text (RPT-003)', async () => {
    const first = accepted(await reports.generateReport(owner, input));
    const second = accepted(
      await reports.generateReport(owner, { ...input, items: [{ compositionId: k.cmp_OCEAN }] }),
    );
    const listed = accepted(await reports.listGeneratedReports(owner));
    expect(listed.slice(0, 2)).toEqual([
      expect.objectContaining({ reportId: second.reportId, songCount: 1, text: second.text }),
      expect.objectContaining({ reportId: first.reportId, songCount: 2, text: first.text }),
    ]);
    expect(await reports.listGeneratedReports(withRole(owner, 'viewer'))).toMatchObject({
      ok: true,
    });
  });
});
