import { Badge } from '@/components/ui/badge';
import type { RecordingReadiness } from '@/lib/dto/rights';

/** Soft fills, not outlines: green when ready, quiet grey when not. */
const READY = 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300';
const NOT_READY = 'bg-muted text-muted-foreground';

type Props = Pick<RecordingReadiness, 'oneStopReady' | 'syncReady'>;

/** A recording's two §6.5 flags. One-stop ready implies every one-stop code is clear (P-04). */
export function ReadinessBadges({ oneStopReady, syncReady }: Props) {
  return (
    <span className="inline-flex flex-wrap gap-1" data-testid="readiness">
      <Badge variant="secondary" className={oneStopReady ? READY : NOT_READY}>
        {oneStopReady ? 'One Stop Ready' : 'Not one-stop ready'}
      </Badge>
      <Badge variant="secondary" className={syncReady ? READY : NOT_READY}>
        {syncReady ? 'Sync ready' : 'Not sync ready'}
      </Badge>
    </span>
  );
}
