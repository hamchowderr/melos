import type { RequestContext } from '@mastra/core/request-context';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ToolResult } from '../../src/lib/agent/tool-result';
import type { GeneratedReportDTO } from '../../src/lib/dto/reports';
import type { TenantContext } from '../../src/server/services/tenant-context';
import { NORTHSTAR, seedNorthstarTenant } from './catalog-support';
import { prepareWorkspaceServices } from './workspace-service';

// melos-ajt.16: the report tools run for the route's tenant; the model never sees report text.

type Run = (input: object, context: { requestContext: RequestContext }) => Promise<unknown>;
type ModelOutput = (result: unknown) => { type: 'json'; value: unknown };

let services: Awaited<ReturnType<typeof prepareWorkspaceServices>>;
let tools: typeof import('../../src/mastra/tools/reports');
let owner: TenantContext;
let requestContext: RequestContext;
const k = NORTHSTAR.keys;

beforeAll(async () => {
  services = await prepareWorkspaceServices('report-tools');
  tools = await import('../../src/mastra/tools/reports');
  owner = await seedNorthstarTenant();
  const { createAgentRequestContext } = await import('../../src/mastra/request-context');
  requestContext = createAgentRequestContext(owner);
});

afterAll(async () => {
  if (owner) await services.connections.closeWorkspaceDatabase(owner.workspaceId);
  await services?.close();
});

const run = (tool: { execute?: unknown }, input: object) =>
  (tool.execute as Run)(input, { requestContext });
const toModel = (tool: { toModelOutput?: unknown }, result: unknown) =>
  (tool.toModelOutput as ModelOutput)(result).value;

describe('melos-ajt.16: report tools (§3.3, §3.6)', () => {
  it('previews a preset for the UI and gives the model only ids, sections and length', async () => {
    const input = { preset: 'sans_lyrics', items: [{ compositionId: k.cmp_OCEAN }] };
    const result = (await run(tools.previewReportTool, input)) as ToolResult<{ text: string }>;
    if (result.status !== 'ok') throw new Error(`refused ${result.error.code}`);
    expect(result.value.text.length).toBeGreaterThan(0);
    const model = toModel(tools.previewReportTool, result) as Record<string, unknown>;
    expect(Object.keys(model).sort()).toEqual([
      'characterCount',
      'enabledSections',
      'items',
      'templateId',
    ]);
    expect(model.characterCount).toBe(result.value.text.length);
    expect(model.enabledSections).not.toContain('lyrics');
  });

  it('generateReport saves a snapshot as the agent and lists templates', async () => {
    const saved = (await run(tools.generateReportTool, {
      preset: 'full',
      items: [{ compositionId: k.cmp_OCEAN }],
    })) as ToolResult<GeneratedReportDTO>;
    if (saved.status !== 'ok') throw new Error(`refused ${saved.error.code}`);
    expect(saved.value.reportId).toMatch(/^rpt_/);
    const templates = (await run(tools.listReportTemplatesTool, {})) as ToolResult<unknown[]>;
    if (templates.status !== 'ok') throw new Error('refused');
    expect(toModel(tools.listReportTemplatesTool, templates)).toEqual(
      expect.arrayContaining([expect.objectContaining({ presetKey: 'sans_lyrics' })]),
    );
  });
});
