import type { ReactNode } from 'react';
import { PitchCard } from '@/components/chat/pitch-table';
import { ToolCard } from '@/components/chat/tool-card';
import type { TodayWorkspaceDTO } from '@/lib/dto/pitches';

function Section({
  label,
  empty,
  children,
}: {
  label: string;
  empty: boolean;
  children: ReactNode;
}) {
  return (
    <div className="pb-2">
      <h4 className="px-4 pt-1 pb-1 text-xs font-medium">{label}</h4>
      {empty ? <p className="px-4 pb-1 text-xs text-muted-foreground">Nothing today.</p> : children}
    </div>
  );
}

/** FollowUpQueue (§3.3): the due cells as PitchCard rows, in P-31 priority order. */
export function FollowUpQueue({ cells }: { cells: TodayWorkspaceDTO['followUpsDue'] }) {
  return (
    <Section label={`Follow-Ups Due (${cells.length})`} empty={cells.length === 0}>
      <ul aria-label="Follow-up queue" className="flex flex-col">
        {cells.map((cell) => (
          <PitchCard key={cell.pitchItemId} cell={cell} show="both" />
        ))}
      </ul>
    </Section>
  );
}

/** getTodayWorkspace's TodayWorkspace (§3.3, CRM-005, DEMO-010). */
export function TodayWorkspace({ today }: { today: TodayWorkspaceDTO }) {
  const notReady = today.readinessIssues.recordings.filter(
    (recording) => !recording.oneStopReady,
  ).length;
  return (
    <ToolCard title={`Today, ${today.date}`}>
      <FollowUpQueue cells={today.followUpsDue} />
      <Section
        label={`Recent Replies (${today.recentReplies.length})`}
        empty={today.recentReplies.length === 0}
      >
        <ul aria-label="Recent Replies" className="flex flex-col">
          {today.recentReplies.map((cell) => (
            <li
              key={cell.pitchItemId}
              className="flex items-center gap-4 px-4 py-1.5 odd:bg-muted/30"
            >
              <span className="min-w-0 flex-1 truncate font-medium">
                {cell.contactName} on {cell.itemTitle}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {cell.receivedAt.slice(0, 10)}
              </span>
            </li>
          ))}
        </ul>
      </Section>
      <Section
        label={`Ready to Pitch (${today.readyToPitch.length})`}
        empty={today.readyToPitch.length === 0}
      >
        <ul aria-label="Ready to Pitch" className="flex flex-col">
          {today.readyToPitch.map((song) => (
            <li
              key={song.recordingId}
              className="flex items-center gap-4 px-4 py-1.5 odd:bg-muted/30"
            >
              <span className="min-w-0 flex-1 truncate font-medium">{song.title}</span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {song.neverPitchedLicensingAgentCount === 1
                  ? '1 licensing agent has not heard it'
                  : `${song.neverPitchedLicensingAgentCount} licensing agents have not heard it`}
              </span>
            </li>
          ))}
        </ul>
      </Section>
      <p className="px-4 pb-3 text-xs text-muted-foreground">
        {notReady === 1
          ? '1 recording is not ready to license.'
          : `${notReady} recordings are not ready to license.`}
      </p>
    </ToolCard>
  );
}
