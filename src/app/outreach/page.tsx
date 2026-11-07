import { resolveWorkspacePage } from '@/app/workspace-page';
import { OutreachBoard, type PitchOption } from '@/components/outreach/outreach-board';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { PageHeader } from '@/components/workspace/page-header';
import { WorkspaceNotReady } from '@/components/workspace/workspace-not-ready';
import { WorkspaceShell } from '@/components/workspace/workspace-shell';
import { PITCH_STATUSES } from '@/lib/dto/pitches';
import { listOutboxMessages } from '@/server/services/outreach/outbox';
import { searchPitches } from '@/server/services/pitches/read';

export const dynamic = 'force-dynamic';

/** /outreach (§2.3 MessageDraftCard; OUT-001, OUT-002, OUT-004): drafts and sent messages. */
export default async function OutreachPage() {
  const workspace = await resolveWorkspacePage();
  if (workspace.status === 'not-ready') {
    return <WorkspaceNotReady status={workspace.workspaceStatus} />;
  }
  const [rows, cells] = await Promise.all([
    listOutboxMessages(workspace.tenant),
    searchPitches(workspace.tenant, { statuses: [...PITCH_STATUSES] }),
  ]);
  const pitches = new Map<string, PitchOption>();
  for (const cell of cells.ok ? cells.value : []) {
    const known = pitches.get(cell.pitchId);
    pitches.set(cell.pitchId, {
      pitchId: cell.pitchId,
      label: known ? `${known.label}, ${cell.itemTitle}` : `${cell.contactName}: ${cell.itemTitle}`,
    });
  }

  return (
    <WorkspaceShell workspaceName={workspace.workspaceName} current="outreach">
      <PageHeader title="Outreach" count={rows.ok ? `${rows.value.length} messages` : undefined} />
      <div className="px-4 pt-3 pb-6 md:px-6">
        {rows.ok ? (
          <OutreachBoard rows={rows.value} pitches={[...pitches.values()]} />
        ) : (
          <Alert>
            <AlertTitle>You do not have access to outreach</AlertTitle>
            <AlertDescription>Ask the workspace owner for access.</AlertDescription>
          </Alert>
        )}
      </div>
    </WorkspaceShell>
  );
}
