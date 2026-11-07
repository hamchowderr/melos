import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TenantContext } from '../../src/server/services/tenant-context';
import { seedNorthstarTenant } from './catalog-support';
import { prepareWorkspaceServices, withRole } from './workspace-service';

let services: Awaited<ReturnType<typeof prepareWorkspaceServices>>;
let templates: typeof import('../../src/server/services/reports/templates');
let owner: TenantContext;

beforeAll(async () => {
  services = await prepareWorkspaceServices('report-templates');
  templates = await import('../../src/server/services/reports/templates');
  owner = await seedNorthstarTenant();
});
afterAll(async () => {
  if (owner) await services.connections.closeWorkspaceDatabase(owner.workspaceId);
  await services?.close();
});

describe('melos-ajt.10: listReportTemplates and resolveTemplate (RPT-001, RPT-002)', () => {
  it('lists the three system presets with their sections in §6.12 order', async () => {
    const listed = await templates.listReportTemplates(withRole(owner, 'viewer'));
    if (!listed.ok) throw new Error('Refused');
    const on = Object.fromEntries(
      listed.value.map((t) => [t.presetKey, t.sections.filter((s) => s.enabled).map((s) => s.id)]),
    );
    expect(listed.value.every((t) => t.isSystem && t.reportType === 'metadata_package')).toBe(true);
    expect(on).toEqual({
      full: [
        'core',
        'rights',
        'creators',
        'composition',
        'recording',
        'metadata',
        'listen',
        'licensing',
        'lyrics',
      ],
      sans_lyrics: [
        'core',
        'rights',
        'creators',
        'composition',
        'recording',
        'metadata',
        'listen',
        'licensing',
      ],
      just_lyrics: ['lyrics'],
    });
    expect(await templates.listReportTemplates(owner, 'custom')).toEqual({ ok: true, value: [] });
    expect(await templates.listReportTemplates(withRole(owner, 'nobody'))).toEqual({
      ok: false,
      error: { code: 'FORBIDDEN' },
    });
  });

  it('resolves a preset or id with overrides and refuses bad input', async () => {
    const database = await services.connections.getWorkspaceDatabase(owner.workspaceId);
    const sans = await templates.resolveTemplate(database, {
      preset: 'sans_lyrics',
      sections: { lyrics: true, rights: false },
    });
    if (!sans.ok) throw new Error('Refused');
    expect(sans.value.sections.filter((s) => !s.enabled).map((s) => s.id)).toEqual(['rights']);
    const byId = await templates.resolveTemplate(database, { templateId: sans.value.templateId });
    expect(byId.ok && byId.value.sections.at(-1)).toEqual({ id: 'lyrics', enabled: false });
    const refused = (error: object) => ({ ok: false, error });
    expect(await templates.resolveTemplate(database, {})).toEqual(
      refused({
        code: 'VALIDATION',
        field: 'templateId',
        reason: 'exactly_one_of_template_id_or_preset',
      }),
    );
    expect(
      await templates.resolveTemplate(database, {
        preset: 'full',
        sections: { bogus: true } as never,
      }),
    ).toEqual(refused({ code: 'VALIDATION', field: 'sections', reason: 'unknown_section' }));
    expect(await templates.resolveTemplate(database, { preset: 'disco_track_info' })).toEqual(
      refused({ code: 'NOT_FOUND' }),
    );
  });
});
