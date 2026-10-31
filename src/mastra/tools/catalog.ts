import { createTool } from '@mastra/core/tools';
import {
  catalogFocusSchema,
  GET_MUSIC_WORKSPACE_TOOL_NAME,
  SEARCH_MUSIC_TOOL_NAME,
  searchMusicInputSchema,
} from '../../lib/agent/catalog-tools';
import { toolResultSchema } from '../../lib/agent/tool-result';
import type { MusicSearchResult, MusicWorkspaceDTO } from '../../lib/dto/catalog';
import { getMusicWorkspace } from '../../server/services/catalog/music-workspace';
import { searchMusic } from '../../server/services/catalog/search';
import { modelOutput, runTool } from './run-tool';

/** searchMusic's §3.6 model fields: one entry per song. */
export const summarizeSearch = (results: MusicSearchResult[]) =>
  results.map(
    ({
      compositionId,
      primaryRecordingId,
      recordingIds,
      title,
      primaryArtistNames,
      matchType,
    }) => ({
      compositionId,
      primaryRecordingId,
      recordingIds,
      title,
      primaryArtistNames,
      matchType,
    }),
  );

/** getMusicWorkspace's §3.6 model fields: ids, identifiers, readiness, writers and pitch counts. */
export function summarizeWorkspace(dto: MusicWorkspaceDTO) {
  const readiness = new Map(dto.readiness.map((entry) => [entry.recordingId, entry]));
  return {
    compositionId: dto.composition?.id ?? null,
    primaryRecordingId: dto.primaryRecordingId,
    title: dto.composition?.title ?? dto.recordings[0]?.title ?? null,
    iswc: dto.composition?.iswc ?? null,
    recordings: dto.recordings.map(({ id, title, versionTitle, isrc }) => ({
      recordingId: id,
      title,
      versionTitle,
      isrc,
      oneStopReady: readiness.get(id)?.oneStopReady ?? false,
      syncReady: readiness.get(id)?.syncReady ?? false,
    })),
    writers: dto.rights.writers.map(({ displayName, shareBp }) => ({ displayName, shareBp })),
    pitchCountsByStatus: dto.pitchSummary.countsByStatus,
  };
}

export const searchMusicTool = createTool({
  id: SEARCH_MUSIC_TOOL_NAME,
  description:
    'Find songs by title, alternate title or text. Returns one result per song with its composition id, primary recording id, recording ids and how it matched. Use it to turn a song name into ids before any other tool.',
  inputSchema: searchMusicInputSchema,
  outputSchema: toolResultSchema<MusicSearchResult[]>(),
  execute: (input, context) => runTool(context, (tenant) => searchMusic(tenant, input)),
  toModelOutput: modelOutput(summarizeSearch),
});

export const getMusicWorkspaceTool = createTool({
  id: GET_MUSIC_WORKSPACE_TOOL_NAME,
  description:
    'Show one song: its composition, recordings, releases, rights, readiness and pitch counts. Takes a composition or recording id from searchMusic or the focused entity.',
  inputSchema: catalogFocusSchema,
  outputSchema: toolResultSchema<MusicWorkspaceDTO>(),
  execute: (input, context) => runTool(context, (tenant) => getMusicWorkspace(tenant, input)),
  toModelOutput: modelOutput(summarizeWorkspace),
});
