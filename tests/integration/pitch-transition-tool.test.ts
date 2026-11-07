import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApprovalRequest } from '../../src/lib/agent/approval';
import type { PitchDTO } from '../../src/lib/dto/pitches';
import { createAgentRequestContext } from '../../src/mastra/request-context';
import * as tables from '../../src/server/db/schema/workspace.generated';
import type { TenantContext } from '../../src/server/services/tenant-context';
import { NORTHSTAR, seedNorthstarTenant } from './catalog-support';
import { prepareWorkspaceServices } from './workspace-service';

// melos-ajt.14: transitionPitchStatus asks first only for closed_won, closed_lost and archived
// (P-07, §6.3); a terminal move writes nothing until approved. Mastra's suspend is stood in for.

type Result = { status: 'ok'; value: PitchDTO } | { status: 'error'; error: { code: string } };
type Execute = (input: object, context: object) => Promise<Result | undefined>;

let services: Awaited<ReturnType<typeof prepareWorkspaceServices>>;
let tools: typeof import('../../src/mastra/tools/pitch-writes');
let owner: TenantContext;
const k = NORTHSTAR.keys;
const PAPER = k.pti_PAPER_REBECCA;

beforeAll(async () => {
  services = await prepareWorkspaceServices('pitch-transition-tool');
  tools = await import('../../src/mastra/tools/pitch-writes');
  owner = await seedNorthstarTenant();
});

afterAll(async () => {
  if (owner) await services.connections.closeWorkspaceDatabase(owner.workspaceId);
  await services?.close();
});

const execute = () => tools.transitionPitchStatusTool.execute as unknown as Execute;
const open = () => services.connections.getWorkspaceDatabase(owner.workspaceId);
const statusOf = async (id: string) =>
  (await (await open()).select().from(tables.pitchItems).where(eq(tables.pitchItems.id, id)))[0]
    .currentStatus;

/** Calls the tool; when it suspends, returns its request and a resume with an answer. */
async function call(input: object) {
  const toolCallId = `call_${crypto.randomUUID()}`;
  const requestContext = createAgentRequestContext(owner);
  let request: ApprovalRequest | undefined;
  const result = await execute()(input, {
    requestContext,
    agent: { toolCallId, suspend: async (payload: ApprovalRequest) => void (request = payload) },
  });
  const resume = (approved: boolean) =>
    execute()(input, {
      requestContext,
      agent: {
        toolCallId,
        suspend: async () => {},
        resumeData: { approved, inputHash: request?.inputHash ?? '' },
      },
    }) as Promise<Result>;
  return { result, request, resume };
}

describe('melos-ajt.14: transitionPitchStatus with terminal-status approval (P-07)', () => {
  it('a terminal move suspends with the cell before and after, and writes nothing until approved', async () => {
    const { result, request, resume } = await call({ pitchItemId: PAPER, toStatus: 'closed_lost' });
    expect(result).toBeUndefined();
    expect(request).toMatchObject({
      kind: 'terminal_status',
      toolName: 'transitionPitchStatus',
      summary: 'Move Paper Planes at 2AM to Rebecca Carter from Awaiting reply to Lost.',
      before: [{ id: PAPER, detail: 'Awaiting reply' }],
      after: [{ id: PAPER, detail: 'Lost' }],
    });
    expect(await statusOf(PAPER)).toBe('awaiting_reply');

    const declined = await resume(false);
    expect(declined).toEqual({ status: 'error', error: { code: 'DECLINED', reason: 'declined' } });
    expect(await statusOf(PAPER)).toBe('awaiting_reply');

    const again = await call({ pitchItemId: PAPER, toStatus: 'closed_lost' });
    const approved = await again.resume(true);
    if (approved.status !== 'ok') throw new Error(`refused ${approved.error.code}`);
    expect(approved.value.items.find((cell) => cell.pitchItemId === PAPER)?.currentStatus).toBe(
      'closed_lost',
    );
    expect(await statusOf(PAPER)).toBe('closed_lost');
  });

  it('an approval for a cell that changed since its preview is STATE_CHANGED', async () => {
    const { request, resume } = await call({ pitchItemId: PAPER, toStatus: 'archived' });
    expect(request?.kind).toBe('terminal_status');
    const { transitionPitchStatus } = await import('../../src/server/services/pitches/status');
    await transitionPitchStatus(owner, { pitchItemId: PAPER, toStatus: 'archived' });
    await transitionPitchStatus(owner, { pitchItemId: PAPER, toStatus: 'closed_lost' });
    expect(await resume(true)).toEqual({ status: 'error', error: { code: 'STATE_CHANGED' } });
  });

  it('a non-terminal move saves at once as the agent, and a refused move asks nothing', async () => {
    const maya = k.pti_NEON_MAYA;
    const before = await statusOf(maya);
    const next = before === 'not_contacted' || before === 'draft' ? 'sent' : 'awaiting_reply';
    const { result, request } = await call({ pitchItemId: maya, toStatus: next });
    expect(request).toBeUndefined();
    if (result?.status !== 'ok') throw new Error('refused');
    expect(result.value.events.at(-1)).toMatchObject({ toStatus: next, actorType: 'agent' });

    const refused = await call({ pitchItemId: maya, toStatus: 'closed_won' });
    expect(refused.request).toBeUndefined();
    expect(refused.result).toMatchObject({ status: 'error', error: { code: 'VALIDATION' } });
  });
});
