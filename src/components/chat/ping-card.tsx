import type { PingResult } from '@/lib/agent/contract';

export function PingCard({ result }: { result: PingResult }) {
  return (
    <section className="ping-card" data-testid="ping-card" aria-label="Workspace ping result">
      <p>Workspace connected</p>
      <dl>
        <dt>Workspace</dt>
        <dd data-testid="ping-workspace-id">{result.workspaceId}</dd>
        <dt>User</dt>
        <dd data-testid="ping-user-id">{result.userId}</dd>
      </dl>
    </section>
  );
}
