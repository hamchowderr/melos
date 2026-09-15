import type { ReactNode } from 'react';

type Props = { details: [term: string, value: ReactNode][] };

/** A card's term and value pairs; a pair without a value is left out. */
export function DetailList({ details }: Props) {
  const shown = details.filter(
    ([, value]) => value !== null && value !== undefined && value !== '',
  );
  if (shown.length === 0) return null;
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
      {shown.map(([term, value]) => (
        <div key={term} className="contents">
          <dt className="text-muted-foreground">{term}</dt>
          <dd className="min-w-0">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
