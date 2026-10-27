import { Badge } from '@/components/ui/badge';
import type { RecordingReadiness } from '@/lib/dto/rights';

type Props = Pick<RecordingReadiness, 'oneStopReady' | 'syncReady'>;

/** A recording's two §6.5 flags. One-stop ready implies every one-stop code is clear (P-04). */
export function ReadinessBadges({ oneStopReady, syncReady }: Props) {
  return (
    <span className="inline-flex flex-wrap gap-1" data-testid="readiness">
      <Badge variant={oneStopReady ? 'default' : 'outline'}>
        {oneStopReady ? 'One Stop Ready' : 'Not one-stop ready'}
      </Badge>
      <Badge variant={syncReady ? 'secondary' : 'outline'}>
        {syncReady ? 'Sync ready' : 'Not sync ready'}
      </Badge>
    </span>
  );
}
