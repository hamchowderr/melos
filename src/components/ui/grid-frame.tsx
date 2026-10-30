import { cn } from 'cn';
import type * as React from 'react';

/**
 * A bordered, spreadsheet-style frame for a Table: compact rows, a muted header and
 * column rules, so every list in the app reads the same dense way.
 */
export function GridFrame({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="grid-frame"
      className={cn(
        'overflow-hidden rounded-md border bg-background',
        '[&_thead_th]:h-8 [&_thead_th]:bg-muted/60 [&_thead_th]:px-3 [&_thead_th]:text-xs [&_thead_th]:font-medium [&_thead_th]:text-muted-foreground',
        '[&_td]:h-9 [&_td]:px-3 [&_td]:py-1 [&_td+td]:border-l [&_th+th]:border-l',
        className,
      )}
      {...props}
    />
  );
}
