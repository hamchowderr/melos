import type { ReactNode } from 'react';

type Props = { title: string; count?: string; children?: ReactNode };

/** A workspace page's title bar: its name, an optional count, and its actions on the right. */
export function PageHeader({ title, count, children }: Props) {
  return (
    <div className="flex min-h-12 flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-2">
      <h1 className="text-sm font-semibold">{title}</h1>
      {count ? <span className="text-xs text-muted-foreground">{count}</span> : null}
      <div className="ml-auto flex items-center gap-2">{children}</div>
    </div>
  );
}
