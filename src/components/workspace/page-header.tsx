import type { ReactNode } from 'react';

type Props = { title: string; count?: string; children?: ReactNode };

/** A workspace page's title row: its name, an optional count, and its actions on the right. */
export function PageHeader({ title, count, children }: Props) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 pt-5 pb-1 md:px-6">
      <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
      {count ? <span className="text-xs text-muted-foreground">{count}</span> : null}
      <div className="ml-auto flex items-center gap-2">{children}</div>
    </div>
  );
}
