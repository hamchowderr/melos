import type { ChatRunError } from '@/lib/agent/run-error';

export function ChatRunErrorNotice({
  error,
  onRetry,
}: {
  error: ChatRunError;
  onRetry: () => void;
}) {
  return (
    <div
      role="alert"
      className="chat-run-error"
      data-testid="chat-run-error"
      data-error-kind={error.kind}
    >
      <p>{error.message}</p>
      <button type="button" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}
