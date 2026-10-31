import { RequestContext } from '@mastra/core/request-context';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ToolResult } from '../../src/lib/agent/tool-result';
import type { MusicSearchResult, MusicWorkspaceDTO } from '../../src/lib/dto/catalog';
import type { TenantContext } from '../../src/server/services/tenant-context';
import { NORTHSTAR, seedNorthstarTenant } from './catalog-support';
import { prepareWorkspaceServices } from './workspace-service';

type Tools = typeof import('../../src/mastra/tools/catalog');
type Run<T> = (input: object, context: { requestContext: RequestContext }) => Promise<T>;
type ModelOutput = (result: unknown) => { type: 'json'; value: unknown };

let services: Awaited<ReturnType<typeof prepareWorkspaceServices>>;
let tools: Tools;
let owner: TenantContext;
let requestContext: RequestContext;
const { cmp_MIDNIGHT: MIDNIGHT, rec_MIDNIGHT: MIDNIGHT_REC } = NORTHSTAR.keys;

beforeAll(async () => {
  services = await prepareWorkspaceServices('catalog-tools');
  tools = await import('../../src/mastra/tools/catalog');
  owner = await seedNorthstarTenant();
  const { createAgentRequestContext } = await import('../../src/mastra/request-context');
  requestContext = createAgentRequestContext(owner);
});

afterAll(async () => {
  if (owner) await services.connections.closeWorkspaceDatabase(owner.workspaceId);
  await services?.close();
});

const search = (input: object, context = requestContext) =>
  (tools.searchMusicTool.execute as unknown as Run<ToolResult<MusicSearchResult[]>>)(input, {
    requestContext: context,
  });
const workspace = (input: object) =>
  (tools.getMusicWorkspaceTool.execute as unknown as Run<ToolResult<MusicWorkspaceDTO>>)(input, {
    requestContext,
  });

describe('searchMusic tool (§3.3, §3.6)', () => {
  it('returns the full results to the UI and only the §3.6 fields to the model', async () => {
    const result = await search({ query: 'Midnight Drive' });
    if (result.status !== 'ok') throw new Error(`refused ${result.error.code}`);
    expect(result.value[0]).toMatchObject({
      compositionId: MIDNIGHT,
      primaryRecordingId: MIDNIGHT_REC,
      matchType: 'exact_title',
      recordings: [expect.objectContaining({ recordingId: MIDNIGHT_REC })],
    });
    const model = (tools.searchMusicTool.toModelOutput as ModelOutput)(result);
    expect(model.type).toBe('json');
    const [first] = model.value as Record<string, unknown>[];
    expect(Object.keys(first).sort()).toEqual(
      [
        'compositionId',
        'matchType',
        'primaryArtistNames',
        'primaryRecordingId',
        'recordingIds',
        'title',
      ].sort(),
    );
  });

  it('returns NO_TENANT and runs no service when the route supplied no tenant', async () => {
    const result = await search({ query: 'Midnight Drive' }, new RequestContext());
    expect(result).toEqual({ status: 'error', error: { code: 'NO_TENANT' } });
  });
});

describe('getMusicWorkspace tool (§3.3, §3.6)', () => {
  it('summarizes the song for the model with ids, readiness, writers and pitch counts', async () => {
    const result = await workspace({ entityType: 'composition', entityId: MIDNIGHT });
    if (result.status !== 'ok') throw new Error(`refused ${result.error.code}`);
    const { value } = (tools.getMusicWorkspaceTool.toModelOutput as ModelOutput)(result) as {
      value: ReturnType<Tools['summarizeWorkspace']>;
    };
    expect(value).toMatchObject({
      compositionId: MIDNIGHT,
      primaryRecordingId: MIDNIGHT_REC,
      title: 'Midnight Drive',
      recordings: [expect.objectContaining({ recordingId: MIDNIGHT_REC })],
    });
    expect(value.writers.length).toBeGreaterThan(0);
    expect(Object.keys(value.recordings[0]).sort()).toEqual(
      ['isrc', 'oneStopReady', 'recordingId', 'syncReady', 'title', 'versionTitle'].sort(),
    );
    // Lyrics and contact details never reach the model (§3.1).
    expect(JSON.stringify(value)).not.toMatch(/lyrics|@/i);
  });

  it('returns NOT_FOUND for an id that is not in this workspace', async () => {
    const result = await workspace({ entityType: 'composition', entityId: 'cmp_NOPE' });
    expect(result).toEqual({ status: 'error', error: { code: 'NOT_FOUND' } });
  });
});
