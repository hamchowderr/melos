import type { ReactNode } from 'react';
import type { ToolError } from '@/lib/agent/tool-result';

/** A tool result in the chat: one soft rounded panel with a small heading (§3.1). */
export function ToolCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section
      aria-label={title}
      className="my-2 overflow-hidden rounded-xl bg-background text-sm ring-1 ring-foreground/[0.07]"
    >
      <h3 className="px-4 pt-3 pb-2 text-xs font-medium text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

/** While the tool runs. */
export function ToolPending({ label }: { label: string }) {
  return (
    <p role="status" className="my-2 text-sm text-muted-foreground">
      {label}
    </p>
  );
}

const ERROR_TEXT: Record<string, string> = {
  NOT_FOUND: 'That item is not in this workspace.',
  NO_TENANT: 'No active workspace was found for this chat. Reload the page and try again.',
  VALIDATION: 'The request was not valid.',
  FORBIDDEN: 'Your role cannot see this.',
  DECLINED: 'Not approved, so nothing was changed.',
  STATE_CHANGED: 'This changed while it waited for approval, so nothing was saved.',
};

/** A refusal or an unreadable result, in one plain sentence. */
export function ToolErrorNotice({ error }: { error: ToolError | null }) {
  const text = error
    ? (ERROR_TEXT[error.code] ?? 'The workspace could not answer that.')
    : 'The result could not be read.';
  return (
    <p role="alert" data-error-code={error?.code} className="my-2 text-sm text-destructive">
      {text}
    </p>
  );
}
