import type { RequestContext } from '@mastra/core/request-context';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ToolResult } from '../../src/lib/agent/tool-result';
import type { PitchDTO } from '../../src/lib/dto/pitches';
import type { TenantContext } from '../../src/server/services/tenant-context';
import { NORTHSTAR, seedNorthstarTenant } from './catalog-support';
import { prepareWorkspaceServices } from './workspace-service';

// melos-ajt.14: the draft pitch writes run from the agent without approval (§3.3) and are recorded
// as the agent's (§6.6). The tools run as Mastra runs them.

type Run = (
  input: object,
  context: { requestContext: RequestContext },
) => Promise<ToolResult<PitchDTO>>;
type ModelOutput = (result: unknown) => { type: 'json'; value: unknown };

let services: Awaited<ReturnType<typeof prepareWorkspaceServices>>;
let tools: typeof import('../../src/mastra/tools/pitch-writes');
let owner: TenantContext;
let requestContext: RequestContext;
const k = NORTHSTAR.keys;

beforeAll(async () => {
  services = await prepareWorkspaceServices('pitch-write-tools');
  tools = await import('../../src/mastra/tools/pitch-writes');
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
const accepted = (result: ToolResult<PitchDTO>) => {
  if (result.status !== 'ok') throw new Error(`refused ${JSON.stringify(result.error)}`);
  return result.value;
};

describe('melos-ajt.14: draft pitch write tools (§3.3)', () => {
  it('createPitch writes the pitch as the agent and returns the PitchDTO for PitchCard', async () => {
    const created = await run(tools.createPitchTool, {
      contactId: k.con_MALIK,
      items: [{ itemType: 'composition', itemId: k.cmp_HOME }],
      subject: 'Home for your trailer',
    });
    const pitch = accepted(created);
    expect(pitch).toMatchObject({ contactId: k.con_MALIK, subject: 'Home for your trailer' });
    expect(pitch.items).toEqual([
      expect.objectContaining({ itemId: k.cmp_HOME, currentStatus: 'draft' }),
    ]);
    expect(pitch.events.every((event) => event.actorType === 'agent')).toBe(true);
    const toModel = tools.createPitchTool.toModelOutput as unknown as ModelOutput;
    expect(toModel(created).value).toMatchObject({
      pitchId: pitch.pitchId,
      items: [{ itemId: k.cmp_HOME, currentStatus: 'draft' }],
      lastOutboundMessage: null,
    });

    const added = accepted(
      await run(tools.addPitchItemTool, {
        pitchId: pitch.pitchId,
        itemType: 'recording',
        itemId: k.rec_NEON,
      }),
    );
    expect(added.items.map((cell) => cell.itemId)).toEqual([k.cmp_HOME, k.rec_NEON]);

    const noted = accepted(
      await run(tools.addPitchNoteTool, { pitchId: pitch.pitchId, note: 'Ask about the cue' }),
    );
    expect(noted.events.at(-1)).toMatchObject({
      eventType: 'note_added',
      note: 'Ask about the cue',
      actorType: 'agent',
    });
  });

  it('passes a service refusal through without writing', async () => {
    const refused = await run(tools.createPitchTool, {
      contactId: 'con_missing',
      items: [{ itemType: 'composition', itemId: k.cmp_HOME }],
    });
    expect(refused).toEqual({ status: 'error', error: { code: 'NOT_FOUND' } });
  });
});
