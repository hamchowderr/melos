'use client';

import { Check } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { dismissOnboardingAction } from '@/app/today/onboarding-action';
import { Button } from '@/components/ui/button';
import type { OnboardingChecklistDTO } from '@/lib/dto/onboarding';
import { cn } from '@/lib/utils';
import { WORKSPACE_TYPE_INFO } from '@/lib/workspace-type';

/**
 * OnboardingChecklist (ONB-003): the workspace type's getting-started items at the top of /today.
 * Hidden when every item is done or the member dismissed it.
 */
export function OnboardingChecklist({ checklist }: { checklist: OnboardingChecklistDTO }) {
  const [hidden, setHidden] = useState(false);
  const [pending, setPending] = useState(false);
  if (hidden || checklist.dismissed || checklist.doneCount === checklist.total) return null;

  async function dismiss() {
    setPending(true);
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
    const ok = await dismissOnboardingAction(timezone).catch(() => false);
    setPending(false);
    if (ok) setHidden(true);
  }

  return (
    <section
      aria-label="Getting started"
      className="flex flex-col gap-2 rounded-xl bg-muted/50 p-3"
      data-testid="onboarding-checklist"
    >
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-medium">
          Getting started{' '}
          <span className="font-normal text-muted-foreground">
            {checklist.doneCount} of {checklist.total}
          </span>
        </h2>
        <span className="text-muted-foreground text-xs">
          {WORKSPACE_TYPE_INFO[checklist.workspaceType].label}
        </span>
        <Button variant="ghost" size="sm" className="ml-auto" onClick={dismiss} disabled={pending}>
          Dismiss
        </Button>
      </div>
      <ol className="grid gap-1.5 sm:grid-cols-2">
        {checklist.items.map((item) => (
          <li key={item.key} data-done={item.done || undefined}>
            <Link
              href={item.href}
              className="flex items-center gap-2 rounded-lg bg-background px-3 py-2 text-sm transition-colors hover:bg-accent"
            >
              <span
                aria-hidden
                className={cn(
                  'flex size-4 shrink-0 items-center justify-center rounded-full',
                  item.done ? 'bg-primary text-primary-foreground' : 'bg-muted',
                )}
              >
                {item.done ? <Check className="size-3" /> : null}
              </span>
              <span className={cn(item.done && 'text-muted-foreground line-through')}>
                {item.label}
              </span>
              <span className="sr-only">{item.done ? '(done)' : '(to do)'}</span>
            </Link>
          </li>
        ))}
      </ol>
    </section>
  );
}
