import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApprovalRequest } from '../../src/lib/agent/approval';
import { createAgentRequestContext } from '../../src/mastra/request-context';
import * as tables from '../../src/server/db/schema/workspace.generated';
import type { TenantContext } from '../../src/server/services/tenant-context';
import { NORTHSTAR, seedNorthstarTenant } from './catalog-support';
import { prepareWorkspaceServices } from './workspace-service';

// melos-qlw.5: attestRepresentation and updateLicensingContacts always ask first (§6.3, §7.4). The
// tools run as Mastra runs them, with a stand-in for its suspend and resume (SRC-042).

type Tool = { execute?: unknown };
type Result =
  | { status: 'ok'; value: { compositionId: string | null } }
  | { status: 'error'; error: { code: string } };

let services: Awaited<ReturnType<typeof prepareWorkspaceServices>>;
let tools: typeof import('../../src/mastra/tools/representation-writes');
let representation: typeof import('../../src/server/services/rights/representation');
let owner: TenantContext;
const { rec_OCEAN: OCEAN_REC, pty_CARTER_SYNC: CARTER, pty_MALIK: MALIK } = NORTHSTAR.keys;
const INTEREST = NORTHSTAR.keys['publishing_interests:OCEAN_SILVERLINE_WORLD'];

beforeAll(async () => {
  services = await prepareWorkspaceServices('representation-tools');
  tools = await import('../../src/mastra/tools/representation-writes');
  representation = await import('../../src/server/services/rights/representation');
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

describe('melos-qlw.5: representation and licensing-contact tools with approval (§3.3, §6.3)', () => {
  it('attestRepresentation shows the holder before and after; an approval writes it with approval.granted', async () => {
    const input = { interestType: 'publishing' as const, interestId: INTEREST, attested: true };
    expect(
      (await representation.attestRepresentation(owner, { ...input, attested: false })).ok,
    ).toBe(true);
    const { request, resume, toolCallId } = await suspend(tools.attestRepresentationTool, input);
    expect(request).toMatchObject({ kind: 'representation', toolName: 'attestRepresentation' });
    expect(request.before[0].detail).toContain('not attested');
    expect(request.after[0].detail).toContain('representation attested');
    expect((await resume(true)).status).toBe('ok');
    expect(await actionsOf(toolCallId)).toEqual([
      'approval.requested',
      'representation.attest',
      'approval.granted',
    ]);
  });

  it('attestRepresentation refuses with STATE_CHANGED and approval.stale when the interest changed', async () => {
    const input = { interestType: 'publishing' as const, interestId: INTEREST, attested: false };
    const { resume, toolCallId } = await suspend(tools.attestRepresentationTool, input);
    expect((await representation.attestRepresentation(owner, input)).ok).toBe(true);
    expect(await resume(true)).toEqual({ status: 'error', error: { code: 'STATE_CHANGED' } });
    expect(await actionsOf(toolCallId)).toEqual(['approval.requested', 'approval.stale']);
  });

  it('updateLicensingContacts: a decline writes nothing; an approval replaces the set', async () => {
    const input = { recordingId: OCEAN_REC, contacts: [{ partyId: CARTER, notes: 'Sync desk' }] };
    const declined = await suspend(tools.updateLicensingContactsTool, input);
    expect(declined.request.kind).toBe('licensing_contact');
    expect(declined.request.after).toEqual([
      { id: CARTER, label: expect.any(String), detail: 'Sync desk' },
    ]);
    expect(await declined.resume(false)).toEqual({
      status: 'error',
      error: { code: 'DECLINED', reason: 'declined' },
    });
    expect(await actionsOf(declined.toolCallId)).toEqual([
      'approval.requested',
      'approval.declined',
    ]);

    const approved = await suspend(tools.updateLicensingContactsTool, input);
    expect((await approved.resume(true)).status).toBe('ok');
    expect(await actionsOf(approved.toolCallId)).toEqual([
      'approval.requested',
      'licensing_contacts.replace',
      'approval.granted',
    ]);
  });

  it('an unknown contact party never asks: NOT_FOUND before any approval row', async () => {
    const execute = tools.updateLicensingContactsTool.execute as (
      i: object,
      c: object,
    ) => Promise<Result>;
    const toolCallId = `call_${crypto.randomUUID()}`;
    const input = {
      recordingId: OCEAN_REC,
      contacts: [{ partyId: MALIK }, { partyId: 'pty_NONE' }],
    };
    const result = await execute(input, {
      requestContext: createAgentRequestContext(owner),
      agent: { toolCallId, suspend: async () => {} },
    });
    expect(result).toEqual({ status: 'error', error: { code: 'NOT_FOUND' } });
    expect(await actionsOf(toolCallId)).toEqual([]);
  });
});
