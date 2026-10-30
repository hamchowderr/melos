import { cn } from 'cn';
import type * as React from 'react';

/**
 * A soft, rounded frame for a Table: compact rows split by faint dividers and a quiet header,
 * with no column rules, so every list in the app reads the same clean way.
 */
export function GridFrame({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="grid-frame"
      className={cn(
        'overflow-hidden rounded-lg bg-background ring-1 ring-foreground/[0.07]',
        '[&_thead_tr]:border-border/60 [&_thead_th]:h-9 [&_thead_th]:bg-muted/40 [&_thead_th]:px-4 [&_thead_th]:text-xs [&_thead_th]:font-medium [&_thead_th]:text-muted-foreground',
        '[&_tbody_tr]:border-border/50 [&_td]:h-11 [&_td]:px-4 [&_td]:py-1.5 [&_tfoot]:border-border/50 [&_tfoot]:bg-muted/30',
        className,
      )}
      {...props}
    />
  );
}
