'use client';

import { useRenderTool } from '@copilotkit/react-core/v2';
import type { ReactElement } from 'react';
import type { z } from 'zod';
import { FocusOn } from '@/components/chat/focus-context';
import { MusicWorkspaceCard } from '@/components/chat/music-workspace-card';
import { OwnershipProposal } from '@/components/chat/ownership-proposal';
import { PingCard } from '@/components/chat/ping-card';
import { SongResults } from '@/components/chat/song-results';
import { ToolCard, ToolErrorNotice, ToolPending } from '@/components/chat/tool-card';
import { ReadinessChecklist } from '@/components/rights/readiness-checklist';
import { RightsPanel } from '@/components/rights/rights-panel';
import {
  catalogFocusSchema,
  defaultOwnershipInputSchema,
  GET_MUSIC_WORKSPACE_TOOL_NAME,
  GET_READINESS_ISSUES_TOOL_NAME,
  GET_RIGHTS_SUMMARY_TOOL_NAME,
  PROPOSE_DEFAULT_OWNERSHIP_TOOL_NAME,
  readinessIssuesInputSchema,
  SEARCH_MUSIC_TOOL_NAME,
  searchMusicInputSchema,
} from '@/lib/agent/catalog-tools';
import {
  type FocusedEntity,
  PING_TOOL_NAME,
  pingInputSchema,
  pingResultSchema,
} from '@/lib/agent/contract';
import {
  UPDATE_WRITER_SHARES_TOOL_NAME,
  writerSharesInputSchema,
} from '@/lib/agent/rights-write-tools';
import { parseToolResult } from '@/lib/agent/tool-result';
import type { MusicSearchResult, MusicWorkspaceDTO } from '@/lib/dto/catalog';
import type {
  DefaultOwnershipProposal,
  ReadinessReportDTO,
  RightsSummaryDTO,
} from '@/lib/dto/rights';

type RenderProps<A> = { status: string; args?: Partial<A>; result?: unknown };

/** One structured renderer per tool (§3.1): pending, refusal, or the component for the DTO. */
const renderResult =
  <T, A = unknown>(pending: string, render: (value: T, args: Partial<A>) => ReactElement) =>
  (props: RenderProps<A>) => {
    if (props.status !== 'complete') return <ToolPending label={pending} />;
    const result = parseToolResult<T>(props.result);
    if (result?.status !== 'ok') return <ToolErrorNotice error={result?.error ?? null} />;
    return render(result.value, props.args ?? {});
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

/** A rights summary's entity: its composition, or a lone recording's master. */
const rightsFocus = (rights: RightsSummaryDTO): FocusedEntity | null =>
  rights.compositionId
    ? { entityType: 'composition', entityId: rights.compositionId }
    : rights.masters[0]
      ? { entityType: 'recording', entityId: rights.masters[0].recordingId }
      : null;

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
        <FocusOn entity={workspace.focus}>
          <MusicWorkspaceCard workspace={workspace} />
        </FocusOn>
      )),
    },
    [],
  );
  useRenderTool(
    {
      name: GET_RIGHTS_SUMMARY_TOOL_NAME,
      parameters: catalogFocusSchema,
      render: renderResult<RightsSummaryDTO>('Reading the rights...', (rights) => (
        <FocusOn entity={rightsFocus(rights)}>
          <RightsPanel rights={rights} recordingTitles={masterLabels(rights)} />
        </FocusOn>
      )),
    },
    [],
  );
  useRenderTool(
    {
      name: GET_READINESS_ISSUES_TOOL_NAME,
      parameters: readinessIssuesInputSchema,
      render: renderResult<ReadinessReportDTO, z.infer<typeof readinessIssuesInputSchema>>(
        'Checking readiness...',
        (report, args) => (
          <ToolCard title="Rights readiness">
            <div className="px-3 pb-3">
              <ReadinessChecklist
                recordings={report.recordings}
                onlyNotReady={args.onlyNotReady ?? true}
              />
            </div>
          </ToolCard>
        ),
      ),
    },
    [],
  );
  useRenderTool(
    {
      name: PROPOSE_DEFAULT_OWNERSHIP_TOOL_NAME,
      parameters: defaultOwnershipInputSchema,
      render: renderResult<DefaultOwnershipProposal>(
        'Working out your ownership...',
        (proposal) => <OwnershipProposal proposal={proposal} />,
      ),
    },
    [],
  );
  useRenderTool(
    {
      name: UPDATE_WRITER_SHARES_TOOL_NAME,
      parameters: writerSharesInputSchema,
      // While suspended the call has no result; ConfirmationCard asks (melos-qlw.3).
      render: renderResult<RightsSummaryDTO>('Waiting for your approval...', (rights) => (
        <FocusOn entity={rightsFocus(rights)}>
          <RightsPanel rights={rights} recordingTitles={masterLabels(rights)} />
        </FocusOn>
      )),
    },
    [],
  );
}
