import { PITCH_STATUS_LABELS, type PitchEventDTO, type PitchStatus } from '@/lib/dto/pitches';

type TimelineMessage = {
  messageId: string;
  direction: 'outbound' | 'inbound';
  status: string;
  subject: string | null;
  sentAt: string | null;
  receivedAt: string | null;
  createdAt: string;
  bodyText?: string | null;
};

const label = (status: PitchStatus | null) => (status ? PITCH_STATUS_LABELS[status] : null);

function eventText(event: PitchEventDTO) {
  const words = event.eventType.replace(/_/g, ' ');
  const move =
    event.fromStatus || event.toStatus
      ? `${label(event.fromStatus) ?? 'new'} to ${label(event.toStatus) ?? 'none'}`
      : null;
  return [words, move, event.note].filter(Boolean).join(' · ');
}

function messageText(message: TimelineMessage) {
  const kind =
    message.direction === 'inbound'
      ? 'Reply'
      : message.status === 'sent'
        ? 'Sent'
        : `Message (${message.status})`;
  return `${kind}: ${message.subject ?? '(no subject)'}`;
}

/** PitchTimeline (§3.3): a pitch's events and messages in time order, oldest first. */
export function PitchTimeline({
  events = [],
  messages,
}: {
  events?: PitchEventDTO[];
  messages: TimelineMessage[];
}) {
  const rows: { key: string; at: string; text: string; body?: string | null }[] = [
    ...events.map((event) => ({
      key: event.eventId,
      at: event.occurredAt,
      text: eventText(event),
    })),
    ...messages.map((message) => ({
      key: message.messageId,
      at: message.receivedAt ?? message.sentAt ?? message.createdAt,
      text: messageText(message),
      body: message.bodyText ?? null,
    })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  if (rows.length === 0) return null;
  return (
    <ol aria-label="Timeline" className="flex flex-col px-4 py-2">
      {rows.map((row) => (
        <li key={row.key} className="flex gap-3 py-1 text-xs">
          <span className="shrink-0 text-muted-foreground tabular-nums">{row.at.slice(0, 10)}</span>
          <span className="min-w-0">
            {row.text}
            {row.body ? (
              <span className="mt-1 block whitespace-pre-wrap text-muted-foreground">
                {row.body}
              </span>
            ) : null}
          </span>
        </li>
      ))}
    </ol>
  );
}
