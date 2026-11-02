import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApprovalRequest } from '../../src/lib/agent/approval';
import { createAgentRequestContext } from '../../src/mastra/request-context';
import * as tables from '../../src/server/db/schema/workspace.generated';
import type { TenantContext } from '../../src/server/services/tenant-context';
import { NORTHSTAR, seedNorthstarTenant } from './catalog-support';
import { prepareWorkspaceServices } from './workspace-service';

// melos-qlw.4: updatePublishingShares and updateMasterShares always ask first (§6.3, §7.4). The
// tools run as Mastra runs them, with a stand-in for its suspend and resume (SRC-042).

type Tool = { execute?: unknown };
type Result =
  | { status: 'ok'; value: { compositionId: string | null } }
  | { status: 'error'; error: { code: string } };

let services: Awaited<ReturnType<typeof prepareWorkspaceServices>>;
let tools: typeof import('../../src/mastra/tools/rights-writes');
let holders: typeof import('../../src/server/services/rights/holder-shares');
let owner: TenantContext;
const { cmp_OCEAN: OCEAN, rec_OCEAN: OCEAN_REC } = NORTHSTAR.keys;
const { pty_SILVERLINE: SILVERLINE, pty_NIGHTSHIFT: NIGHTSHIFT } = NORTHSTAR.keys;

beforeAll(async () => {
  services = await prepareWorkspaceServices('holder-share-tools');
  tools = await import('../../src/mastra/tools/rights-writes');
  holders = await import('../../src/server/services/rights/holder-shares');
  owner = await seedNorthstarTenant();
});

afterAll(async () => {
  if (owner) await services.connections.closeWorkspaceDatabase(owner.workspaceId);
  await services?.close();
});

/** Calls the tool, which suspends; returns its request and a resume with the given answer. */
async function suspend(tool: Tool, input: object) {
  const execute = tool.execute as (input: object, context: object) => Promise<Result | undefined>;
  const toolCallId = `call_${crypto.randomUUID()}`;
  const requestContext = createAgentRequestContext(owner);
  let request: ApprovalRequest | undefined;
  const suspended = await execute(input, {
    requestContext,
    agent: {
      toolCallId,
      suspend: async (payload: ApprovalRequest) => {
        request = payload;
      },
    },
  });
  expect(suspended).toBeUndefined();
  if (!request) throw new Error('The tool did not suspend');
  const asked = request;
  const resume = (approved: boolean) =>
    execute(input, {
      requestContext,
      agent: {
        toolCallId,
        suspend: async () => {},
        resumeData: { approved, inputHash: asked.inputHash },
      },
    }) as Promise<Result>;
  return { request: asked, resume, toolCallId };
}

const actionsOf = async (toolCallId: string) =>
  (
    await (
      await services.connections.getWorkspaceDatabase(owner.workspaceId)
    )
      .select({ action: tables.auditLog.action })
      .from(tables.auditLog)
      .where(eq(tables.auditLog.approvalToolCallId, toolCallId))
      .orderBy(tables.auditLog.id)
  ).map(({ action }) => action);

const publishing = (silverline: number, nightshift: number) => ({
  compositionId: OCEAN,
  territory: 'WORLD',
  shares: [
    { publisherPartyId: SILVERLINE, shareBp: silverline },
    { publisherPartyId: NIGHTSHIFT, shareBp: nightshift },
  ],
});

describe('melos-qlw.4: holder share tools with approval (§3.3, §6.3)', () => {
  it('updatePublishingShares shows the WORLD set, then an approval writes it with approval.granted', async () => {
    const { request, resume, toolCallId } = await suspend(
      tools.updatePublishingSharesTool,
      publishing(7000, 3000),
    );
    expect(request).toMatchObject({ kind: 'rights_change', toolName: 'updatePublishingShares' });
    expect(request.after.map(({ shareBp }) => shareBp)).toEqual([7000, 3000]);
    expect(await actionsOf(toolCallId)).toEqual(['approval.requested']);
    const result = await resume(true);
    expect(result).toMatchObject({ status: 'ok', value: { compositionId: OCEAN } });
    expect(await actionsOf(toolCallId)).toEqual([
      'approval.requested',
      'publishing_shares.replace',
      'approval.granted',
    ]);
  });

  it('updatePublishingShares refuses with STATE_CHANGED and approval.stale when the set changed', async () => {
    const { resume, toolCallId } = await suspend(
      tools.updatePublishingSharesTool,
      publishing(6000, 4000),
    );
    const shares = [
      { partyId: SILVERLINE, shareBp: 5000 },
      { partyId: NIGHTSHIFT, shareBp: 5000 },
    ];
    expect(
      (
        await holders.updatePublishingShares(owner, {
          compositionId: OCEAN,
          territory: 'WORLD',
          shares,
        })
      ).ok,
    ).toBe(true);
    expect(await resume(true)).toEqual({ status: 'error', error: { code: 'STATE_CHANGED' } });
    expect(await actionsOf(toolCallId)).toEqual(['approval.requested', 'approval.stale']);
  });

  it('updateMasterShares: a decline writes nothing; an approval writes master_shares.replace', async () => {
    const input = {
      recordingId: OCEAN_REC,
      shares: [{ ownerPartyId: SILVERLINE, shareBp: 10000 }],
    };
    const declined = await suspend(tools.updateMasterSharesTool, input);
    expect(await declined.resume(false)).toEqual({
      status: 'error',
      error: { code: 'DECLINED', reason: 'declined' },
    });
    expect(await actionsOf(declined.toolCallId)).toEqual([
      'approval.requested',
      'approval.declined',
    ]);

    const approved = await suspend(tools.updateMasterSharesTool, input);
    expect(approved.request.summary).toContain('100%');
    expect((await approved.resume(true)).status).toBe('ok');
    expect(await actionsOf(approved.toolCallId)).toEqual([
      'approval.requested',
      'master_shares.replace',
      'approval.granted',
    ]);
  });

  it('a set the write would refuse never asks: VALIDATION before any approval row', async () => {
    const execute = tools.updatePublishingSharesTool.execute as (
      i: object,
      c: object,
    ) => Promise<Result>;
    const toolCallId = `call_${crypto.randomUUID()}`;
    const result = await execute(publishing(8000, 8000), {
      requestContext: createAgentRequestContext(owner),
      agent: { toolCallId, suspend: async () => {} },
    });
    expect(result).toMatchObject({
      status: 'error',
      error: { code: 'VALIDATION', reason: 'total_over_10000' },
    });
    expect(await actionsOf(toolCallId)).toEqual([]);
  });
});
