import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ServiceResult } from '../../src/server/services/service-result';
import type { TenantContext } from '../../src/server/services/tenant-context';
import { NORTHSTAR, seedNorthstarTenant } from './catalog-support';
import { prepareWorkspaceServices } from './workspace-service';

let services: Awaited<ReturnType<typeof prepareWorkspaceServices>>;
let reports: typeof import('../../src/server/services/reports/preview');
let templates: typeof import('../../src/server/services/reports/templates');
let owner: TenantContext;
const k = NORTHSTAR.keys;
function accepted<T>(result: ServiceResult<T>): T {
  if (!result.ok) throw new Error(`Refused with ${JSON.stringify(result.error)}`);
  return result.value;
}

beforeAll(async () => {
  services = await prepareWorkspaceServices('reports-preview');
  reports = await import('../../src/server/services/reports/preview');
  templates = await import('../../src/server/services/reports/templates');
  owner = await seedNorthstarTenant();
  const listed = await templates.listReportTemplates(owner);
  for (const t of listed.ok ? listed.value : []) presets[t.presetKey ?? ''] = t.templateId;
});
afterAll(async () => {
  if (owner) await services.connections.closeWorkspaceDatabase(owner.workspaceId);
  await services?.close();
});

const presets: Record<string, string> = {};
const LYRICS = [
  'Salt on the window, light on the tide',
  'You said the harbor keeps what we hide',
  'Ocean blue, ocean blue',
  'I keep sailing back to you',
].join('\n');
const rowCount = async () => {
  const database = await services.connections.getWorkspaceDatabase(owner.workspaceId);
  const [row] = await database.all<{ n: number }>(
    sql`SELECT (SELECT count(*) FROM audit_log) + (SELECT count(*) FROM generated_reports) AS n`,
  );
  return row.n;
};

describe('melos-ajt.10: previewReport (RPT-001, RPT-002, RPT-005)', () => {
  it('DEMO-009: sans_lyrics on cmp_OCEAN expands to rec_OCEAN and drops only the lyrics', async () => {
    const before = await rowCount();
    const items = [{ compositionId: k.cmp_OCEAN }];
    const full = accepted(await reports.previewReport(owner, { preset: 'full', items }));
    const sans = accepted(await reports.previewReport(owner, { preset: 'sans_lyrics', items }));
    expect(sans).toMatchObject({
      templateId: presets.sans_lyrics,
      items: [{ recordingId: k.rec_OCEAN, compositionId: k.cmp_OCEAN }],
    });
    expect(sans.sections.filter((s) => !s.enabled).map((s) => s.id)).toEqual(['lyrics']);
    expect(full.text).toContain(`Lyrics\n${LYRICS}`);
    expect(full.text.endsWith(LYRICS)).toBe(true);
    expect(sans.text).toBe(full.text.slice(0, full.text.indexOf('\n\nLyrics')));
    expect(sans.text).toContain('Writers: Alex Ramirez 50%, Jordan Taylor 50%');
    expect(sans.text).toContain('Link: https://media.example/ocean-blue (from 0:35)');
    const lyrics = accepted(await reports.previewReport(owner, { preset: 'just_lyrics', items }));
    expect(lyrics.text).toBe(`Ocean Blue\n\nLyrics\n${LYRICS}`);
    expect(await rowCount()).toBe(before);
  });

  it('repeats the sections per song in item order, with overrides', async () => {
    const two = accepted(
      await reports.previewReport(owner, {
        templateId: presets.full,
        items: [{ recordingId: k.rec_MIDNIGHT }, { compositionId: k.cmp_OCEAN }],
        sections: { lyrics: false, rights: false },
      }),
    );
    const blocks = two.text.split('\n\n---\n\n');
    expect(blocks.map((block) => block.split('\n')[0])).toEqual(['Midnight Drive', 'Ocean Blue']);
    expect(blocks[0]).toContain('ISRC: USDMO2600001');
    expect(blocks[0]).toContain('One-stop: yes');
    expect(two.text).not.toContain('Writers:');
    expect(two.text).not.toContain(LYRICS);
  });

  it('refuses bad input, an unknown song and a role without report:read', async () => {
    const items = [{ recordingId: k.rec_OCEAN }];
    const cases: [Parameters<typeof reports.previewReport>[1], object][] = [
      [
        { preset: 'full', items: [] },
        { code: 'VALIDATION', field: 'items', reason: 'one_to_fifty' },
      ],
      [
        { preset: 'full', items: [{ recordingId: k.rec_OCEAN, compositionId: k.cmp_OCEAN }] },
        { code: 'VALIDATION', field: 'items', reason: 'exactly_one_of_recording_or_composition' },
      ],
      [{ preset: 'full', items: [{ recordingId: 'rec_missing' }] }, { code: 'NOT_FOUND' }],
    ];
    for (const [input, error] of cases)
      expect(await reports.previewReport(owner, input), JSON.stringify(input)).toEqual({
        ok: false,
        error,
      });
    expect(
      await reports.previewReport(
        { ...owner, workspaceRole: 'nobody' as never },
        { preset: 'full', items },
      ),
    ).toEqual({ ok: false, error: { code: 'FORBIDDEN' } });
  });
});
