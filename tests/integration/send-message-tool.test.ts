import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApprovalRequest } from '../../src/lib/agent/approval';
import type { MessageDraftDTO, SendResultDTO } from '../../src/lib/dto/outreach';
import { createAgentRequestContext } from '../../src/mastra/request-context';
import * as tables from '../../src/server/db/schema/workspace.generated';
import type { TenantContext } from '../../src/server/services/tenant-context';
import { NORTHSTAR, seedNorthstarTenant } from './catalog-support';
import { prepareWorkspaceServices } from './workspace-service';

// melos-ajt.15: sendMessage always asks first (external_send, §7.4). The approval binds the draft's
// beforeHash and contentHash, so an edit after the request makes the resume STATE_CHANGED; an
// approval sends through the sandbox transport. Mastra's suspend and resume are stood in for.

type Result<T> = { status: 'ok'; value: T } | { status: 'error'; error: { code: string } };
type Execute = (input: object, context: object) => Promise<Result<SendResultDTO> | undefined>;

let services: Awaited<ReturnType<typeof prepareWorkspaceServices>>;
let tools: typeof import('../../src/mastra/tools/outreach');
let transports: typeof import('../../src/server/services/outreach/email-transport');
let sandbox: InstanceType<(typeof transports)['SandboxEmailTransport']>;
let owner: TenantContext;
const k = NORTHSTAR.keys;

beforeAll(async () => {
  services = await prepareWorkspaceServices('send-message-tool');
  tools = await import('../../src/mastra/tools/outreach');
  transports = await import('../../src/server/services/outreach/email-transport');
  sandbox = new transports.SandboxEmailTransport();
  transports.setEmailTransport(sandbox);
  owner = await seedNorthstarTenant();
});

afterAll(async () => {
  transports?.setEmailTransport(undefined);
  if (owner) await services.connections.closeWorkspaceDatabase(owner.workspaceId);
  await services?.close();
});

const execute = () => tools.sendMessageTool.execute as unknown as Execute;

async function draft(subject: string) {
  const { draftPitchMessage } = await import('../../src/server/services/outreach/drafts');
  const drafted = await draftPitchMessage(owner, {
    ...{ pitchId: k.pit_PAPER_REBECCA, purpose: 'follow_up', subject },
    bodyText: 'Checking in on Paper Planes at 2AM.',
  });
  if (!drafted.ok) throw new Error(`refused ${drafted.error.code}`);
  return drafted.value as MessageDraftDTO;
}

async function call(messageId: string) {
  const toolCallId = `call_${crypto.randomUUID()}`;
  const requestContext = createAgentRequestContext(owner);
  let request: ApprovalRequest | undefined;
  const result = await execute()(
    { messageId },
    {
      requestContext,
      agent: {
        toolCallId,
        suspend: async (payload: ApprovalRequest) => {
          request = payload;
        },
      },
    },
  );
  const resume = (approved: boolean) =>
    execute()(
      { messageId },
      {
        requestContext,
        agent: {
          toolCallId,
          suspend: async () => {},
          resumeData: { approved, inputHash: request?.inputHash ?? '' },
        },
      },
    ) as Promise<Result<SendResultDTO>>;
  return { result, request, resume };
}

const statusOf = async (messageId: string) =>
  (
    await (
      await services.connections.getWorkspaceDatabase(owner.workspaceId)
    )
      .select({ status: tables.messages.status })
      .from(tables.messages)
      .where(eq(tables.messages.id, messageId))
  )[0].status;

describe('melos-ajt.15: sendMessage with external_send approval (§7.4, OUT-002, OUT-004)', () => {
  it('suspends with the draft and its contentHash, and sends nothing until approved', async () => {
    const message = await draft('Paper Planes, following up');
    const { result, request, resume } = await call(message.messageId);
    expect(result).toBeUndefined();
    expect(request).toMatchObject({
      kind: 'external_send',
      toolName: 'sendMessage',
      summary: 'Send "Paper Planes, following up" to rebecca@cartersync.example.',
      contentHash: message.contentHash,
      after: [{ label: 'rebecca@cartersync.example', detail: 'to' }],
    });
    expect(sandbox.sent.has(message.messageId)).toBe(false);

    const sent = await resume(true);
    if (sent.status !== 'ok') throw new Error(`refused ${sent.error.code}`);
    expect(sent.value).toMatchObject({ messageId: message.messageId, status: 'sent' });
    expect(sent.value.provider).toBe('sandbox');
    expect(sandbox.sent.get(message.messageId)?.to).toEqual(['rebecca@cartersync.example']);

    // A repeat call returns the stored result and asks nothing.
    const again = await call(message.messageId);
    expect(again.request).toBeUndefined();
    expect(again.result).toMatchObject({ status: 'ok', value: { status: 'sent' } });
  });

  it('an edit after the request makes the approval STATE_CHANGED and sends nothing', async () => {
    const message = await draft('Paper Planes, one more');
    const { request, resume } = await call(message.messageId);
    expect(request?.kind).toBe('external_send');
    const { updateMessageDraft } = await import('../../src/server/services/outreach/update-draft');
    await updateMessageDraft(owner, { messageId: message.messageId, bodyText: 'Edited after.' });
    expect(await resume(true)).toEqual({ status: 'error', error: { code: 'STATE_CHANGED' } });
    expect(await statusOf(message.messageId)).toBe('draft');
    expect(sandbox.sent.has(message.messageId)).toBe(false);
  });

  it('a decline sends nothing', async () => {
    const message = await draft('Paper Planes, declined');
    const { resume } = await call(message.messageId);
    expect(await resume(false)).toMatchObject({ status: 'error', error: { code: 'DECLINED' } });
    expect(await statusOf(message.messageId)).toBe('draft');
  });
});
