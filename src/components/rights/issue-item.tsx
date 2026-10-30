import type { ReactNode } from 'react';
import type { ReadinessIssue } from '@/lib/dto/rights';
import { words } from '@/lib/words';

/** An issue code as words, keeping identifier acronyms upper case. */
export function issueLabel(code: string) {
  return words(code.toLowerCase()).replace(/\b(isrc|iswc|ipi|isni)\b/gi, (m) => m.toUpperCase());
}

/** One readiness issue as a soft card: a severity dot, its label and detail, then its code. */
export function IssueItem({ issue, context }: { issue: ReadinessIssue; context?: ReactNode }) {
  return (
    <li className="rounded-lg bg-muted/50 px-3 py-2">
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className={
            issue.severity === 'blocking'
              ? 'size-2 shrink-0 rounded-full bg-red-500'
              : 'size-2 shrink-0 rounded-full bg-amber-500'
          }
        />
        <span className="font-medium">{issueLabel(issue.code)}</span>
      </div>
      <p className="mt-0.5 text-muted-foreground">
        {context}
        {issue.detail}
      </p>
      <p className="mt-1 font-mono text-[0.65rem] text-muted-foreground/70">{issue.code}</p>
    </li>
  );
}
