import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgentRequestContext } from '../../src/mastra/request-context';
import type { TenantContext } from '../../src/server/services/tenant-context';
import { NORTHSTAR, seedNorthstarTenant } from './catalog-support';
import { prepareWorkspaceServices } from './workspace-service';

type Tools = typeof import('../../src/mastra/tools/rights');
type Tool = { execute?: unknown; toModelOutput?: unknown };
type Result = { status: 'ok'; value: unknown } | { status: 'error'; error: { code: string } };

let services: Awaited<ReturnType<typeof prepareWorkspaceServices>>;
let tools: Tools;
let owner: TenantContext;
const { cmp_MIDNIGHT: MIDNIGHT, rec_MIDNIGHT: MIDNIGHT_REC } = NORTHSTAR.keys;

beforeAll(async () => {
  services = await prepareWorkspaceServices('rights-tools');
  tools = await import('../../src/mastra/tools/rights');
  owner = await seedNorthstarTenant();
});

afterAll(async () => {
  if (owner) await services.connections.closeWorkspaceDatabase(owner.workspaceId);
  await services?.close();
});

/** Runs a tool as the route would, and returns its result and what the model sees. */
async function call(tool: Tool, input: object) {
  const execute = tool.execute as (input: object, context: object) => Promise<Result>;
  const result = await execute(input, { requestContext: createAgentRequestContext(owner) });
  const model = (tool.toModelOutput as (r: Result) => { value: unknown })(result).value;
  return { result, model };
}

describe('getRightsSummary tool (§3.3, §3.6)', () => {
  it('sends the model shares and issue codes, never licensing contacts or details', async () => {
    const { result, model } = await call(tools.getRightsSummaryTool, {
      entityType: 'composition',
      entityId: MIDNIGHT,
    });
    expect(result.status).toBe('ok');
    expect(model).toMatchObject({ compositionId: MIDNIGHT, writerTotalBp: expect.any(Number) });
    expect(Object.keys(model as object).sort()).toEqual(
      ['compositionId', 'issueCodes', 'masters', 'publishing', 'writerTotalBp', 'writers'].sort(),
    );
    expect(JSON.stringify(model)).not.toMatch(/licensingContacts|"detail"|@/);
  });

  it('returns NOT_FOUND for a recording from no live song', async () => {
    const { result } = await call(tools.getRightsSummaryTool, {
      entityType: 'recording',
      entityId: 'rec_NOPE',
    });
    expect(result).toEqual({ status: 'error', error: { code: 'NOT_FOUND' } });
  });
});

describe('getReadinessIssues tool (§3.3, §3.6)', () => {
  it('lists recordings with readiness flags and issue codes only', async () => {
    const { result, model } = await call(tools.getReadinessIssuesTool, { onlyNotReady: false });
    expect(result.status).toBe('ok');
    const rows = model as Record<string, unknown>[];
    expect(rows.find((row) => row.recordingId === MIDNIGHT_REC)).toBeDefined();
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(
        ['compositionId', 'issueCodes', 'oneStopReady', 'recordingId', 'syncReady', 'title'].sort(),
      );
    }
  });
});

describe('proposeDefaultOwnership tool (§3.3, RGT-008)', () => {
  it('keeps only the requested sides', async () => {
    const { result, model } = await call(tools.proposeDefaultOwnershipTool, {
      compositionId: MIDNIGHT,
      sides: ['writer'],
    });
    expect(result.status).toBe('ok');
    const proposal = model as {
      masterShares: unknown;
      publishingShares: unknown;
      blockedReasons: { side: string }[];
    };
    expect(proposal.masterShares).toBeNull();
    expect(proposal.publishingShares).toBeNull();
    expect(proposal.blockedReasons.every(({ side }) => side === 'writer')).toBe(true);
  });
});
