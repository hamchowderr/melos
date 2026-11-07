import type { RequestContext } from '@mastra/core/request-context';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ToolResult } from '../../src/lib/agent/tool-result';
import type { MessageDraftDTO } from '../../src/lib/dto/outreach';
import type { TenantContext } from '../../src/server/services/tenant-context';
import { NORTHSTAR, seedNorthstarTenant } from './catalog-support';
import { prepareWorkspaceServices } from './workspace-service';

// melos-ajt.15: the draft tools save drafts as the agent (§3.3); the model sees no address (§3.6).

type Run = (
  input: object,
  context: { requestContext: RequestContext },
) => Promise<ToolResult<MessageDraftDTO>>;
type ModelOutput = (result: unknown) => { type: 'json'; value: unknown };

let services: Awaited<ReturnType<typeof prepareWorkspaceServices>>;
let tools: typeof import('../../src/mastra/tools/outreach');
let owner: TenantContext;
let requestContext: RequestContext;
const k = NORTHSTAR.keys;

beforeAll(async () => {
  services = await prepareWorkspaceServices('outreach-tools');
  tools = await import('../../src/mastra/tools/outreach');
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

describe('melos-ajt.15: draftPitchMessage and updateMessageDraft tools (§3.3)', () => {
  it('drafts to the contact, edits the draft, and keeps addresses from the model', async () => {
    const drafted = await run(tools.draftPitchMessageTool, {
      pitchId: k.pit_PAPER_REBECCA,
      purpose: 'follow_up',
      subject: 'Paper Planes, following up',
      bodyText: 'Checking in on Paper Planes at 2AM.',
    });
    if (drafted.status !== 'ok') throw new Error(`refused ${drafted.error.code}`);
    expect(drafted.value.to).toEqual([
      expect.objectContaining({ address: 'rebecca@cartersync.example' }),
    ]);
    const toModel = tools.draftPitchMessageTool.toModelOutput as unknown as ModelOutput;
    const model = toModel(drafted).value;
    expect(JSON.stringify(model)).not.toContain('@');
    expect(model).toEqual({
      ...{ messageId: drafted.value.messageId, pitchId: k.pit_PAPER_REBECCA },
      ...{ purpose: 'follow_up', subject: 'Paper Planes, following up', status: 'draft' },
      ...{ to: 'Rebecca Carter', ccCount: 0, bccCount: 0 },
    });

    const updated = await run(tools.updateMessageDraftTool, {
      messageId: drafted.value.messageId,
      subject: 'Paper Planes at 2AM, following up',
    });
    if (updated.status !== 'ok') throw new Error(`refused ${updated.error.code}`);
    expect(updated.value.subject).toBe('Paper Planes at 2AM, following up');
    expect(updated.value.contentHash).not.toBe(drafted.value.contentHash);
  });

  it('refuses to edit a message that was sent', async () => {
    expect(
      await run(tools.updateMessageDraftTool, { messageId: k.msg_PAPER_1, subject: 'x' }),
    ).toEqual({
      status: 'error',
      error: { code: 'VALIDATION', field: 'messageId', reason: 'not_draft' },
    });
  });
});
