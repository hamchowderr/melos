import type { PingResult } from '@/lib/agent/contract';

export function PingCard({ result }: { result: PingResult }) {
  return (
    <section className="ping-card" data-testid="ping-card" aria-label="Workspace ping result">
      <p>Workspace connected</p>
      <dl>
        <dt>Workspace</dt>
        <dd data-testid="ping-workspace-id">{result.organizationId}</dd>
        <dt>User</dt>
        <dd data-testid="ping-user-id">{result.userId}</dd>
        <dt>Role</dt>
        <dd data-testid="ping-workspace-role">{result.workspaceRole}</dd>
      </dl>
    </section>
  );
}
