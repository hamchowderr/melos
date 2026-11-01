'use client';

import { useRenderTool } from '@copilotkit/react-core/v2';
import type { ReactElement } from 'react';
import { MusicWorkspaceCard } from '@/components/chat/music-workspace-card';
import { PingCard } from '@/components/chat/ping-card';
import { SongResults } from '@/components/chat/song-results';
import { ToolErrorNotice, ToolPending } from '@/components/chat/tool-card';
import { RightsPanel } from '@/components/rights/rights-panel';
import {
  catalogFocusSchema,
  GET_MUSIC_WORKSPACE_TOOL_NAME,
  GET_RIGHTS_SUMMARY_TOOL_NAME,
  SEARCH_MUSIC_TOOL_NAME,
  searchMusicInputSchema,
} from '@/lib/agent/catalog-tools';
import { PING_TOOL_NAME, pingInputSchema, pingResultSchema } from '@/lib/agent/contract';
import { parseToolResult } from '@/lib/agent/tool-result';
import type { MusicSearchResult, MusicWorkspaceDTO } from '@/lib/dto/catalog';
import type { RightsSummaryDTO } from '@/lib/dto/rights';

type RenderProps = { status: string; result?: unknown };

/** One structured renderer per tool (§3.1): pending, refusal, or the component for the DTO. */
const renderResult =
  <T,>(pending: string, render: (value: T) => ReactElement) =>
  (props: RenderProps) => {
    if (props.status !== 'complete') return <ToolPending label={pending} />;
    const result = parseToolResult<T>(props.result);
    if (result?.status !== 'ok') return <ToolErrorNotice error={result?.error ?? null} />;
    return render(result.value);
  };

function parsePingResult(result: unknown) {
  try {
    const parsed = pingResultSchema.safeParse(
      typeof result === 'string' ? JSON.parse(result) : result,
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The DTO names no recording titles, so several masters are told apart by their order. */
const masterLabels = (rights: RightsSummaryDTO) =>
  new Map(
    rights.masters.length > 1
      ? rights.masters.map(({ recordingId }, index) => [recordingId, `recording ${index + 1}`])
      : [],
  );

/** Registers the chat renderer of every agent tool, keyed by tool name (§7.4, U-03). */
export function useMelosToolRenderers() {
  useRenderTool(
    {
      name: PING_TOOL_NAME,
      parameters: pingInputSchema,
      render: (props) => {
        if (props.status !== 'complete') return <ToolPending label="Pinging workspace..." />;
        const result = parsePingResult(props.result);
        return result ? <PingCard result={result} /> : <ToolErrorNotice error={null} />;
      },
    },
    [],
  );
  useRenderTool(
    {
      name: SEARCH_MUSIC_TOOL_NAME,
      parameters: searchMusicInputSchema,
      render: renderResult<MusicSearchResult[]>('Searching songs...', (results) => (
        <SongResults results={results} />
      )),
    },
    [],
  );
  useRenderTool(
    {
      name: GET_MUSIC_WORKSPACE_TOOL_NAME,
      parameters: catalogFocusSchema,
      render: renderResult<MusicWorkspaceDTO>('Opening the song...', (workspace) => (
        <MusicWorkspaceCard workspace={workspace} />
      )),
    },
    [],
  );
  useRenderTool(
    {
      name: GET_RIGHTS_SUMMARY_TOOL_NAME,
      parameters: catalogFocusSchema,
      render: renderResult<RightsSummaryDTO>('Reading the rights...', (rights) => (
        <RightsPanel rights={rights} recordingTitles={masterLabels(rights)} />
      )),
    },
    [],
  );
}
