import Link from 'next/link';
import { resolveWorkspacePage } from '@/app/workspace-page';
import { PitchGrid } from '@/components/pitches/pitch-grid';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { PageHeader } from '@/components/workspace/page-header';
import { WorkspaceNotReady } from '@/components/workspace/workspace-not-ready';
import { WorkspaceShell } from '@/components/workspace/workspace-shell';
import { PITCH_STATUS_LABELS, PITCH_STATUSES, type PitchStatus } from '@/lib/dto/pitches';
import { cn } from '@/lib/utils';
import { requirePermission } from '@/server/services/permissions';
import { searchPitches } from '@/server/services/pitches/read';

export const dynamic = 'force-dynamic';

const cellCount = (count: number) => (count === 1 ? '1 pitch' : `${count} pitches`);

/** /pitches (§2.3, CRM-003): every song × contact cell, filtered by one status. */
export default async function PitchesPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const workspace = await resolveWorkspacePage();
  if (workspace.status === 'not-ready') {
    return <WorkspaceNotReady status={workspace.workspaceStatus} />;
  }
  const { status } = await searchParams;
  const filter = PITCH_STATUSES.includes(status as PitchStatus) ? (status as PitchStatus) : null;
  const cells = await searchPitches(workspace.tenant, filter ? { statuses: [filter] } : {});
  const updates = requirePermission(workspace.tenant, { pitch: ['update'] }).ok;
  const chip = (value: PitchStatus | null, label: string) => (
    <Link
      key={label}
      href={value ? `/pitches?status=${value}` : '/pitches'}
      aria-current={value === filter ? 'page' : undefined}
      className={cn(
        'rounded-full px-2.5 py-1 text-xs whitespace-nowrap text-muted-foreground hover:bg-muted',
        value === filter && 'bg-muted font-medium text-foreground',
      )}
    >
      {label}
    </Link>
  );

  return (
    <WorkspaceShell workspaceName={workspace.workspaceName} current="pitches">
      <PageHeader title="Pitches" count={cells.ok ? cellCount(cells.value.length) : undefined} />
      <div className="flex flex-col gap-3 px-4 pt-3 pb-6 md:px-6">
        <nav aria-label="Filter by Status" className="flex flex-wrap gap-1">
          {chip(null, 'All')}
          {PITCH_STATUSES.map((value) => chip(value, PITCH_STATUS_LABELS[value]))}
        </nav>
        {cells.ok ? (
          <PitchGrid cells={cells.value} updates={updates} />
        ) : (
          <Alert>
            <AlertTitle>You do not have access to pitches</AlertTitle>
            <AlertDescription>Ask the workspace owner for access.</AlertDescription>
          </Alert>
        )}
      </div>
    </WorkspaceShell>
  );
}
