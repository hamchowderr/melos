import Link from 'next/link';
import { roleWords } from '@/components/chat/contact-grid';
import { ToolCard } from '@/components/chat/tool-card';
import type { ContactDetailDTO } from '@/lib/dto/contacts';
import { PITCH_STATUS_LABELS } from '@/lib/dto/pitches';

const day = (at: string) => at.slice(0, 10);

/** getContact's ContactCard (§3.3): profile, methods, pitch cells and recent messages. */
export function ContactCard({ contact }: { contact: ContactDetailDTO }) {
  return (
    <ToolCard title="Contact">
      <div className="flex items-start justify-between gap-3 px-4 pb-2">
        <div className="min-w-0">
          <p className="text-base font-semibold">{contact.displayName}</p>
          <p className="text-xs text-muted-foreground">
            {[contact.organizationName, roleWords(contact.roles)].filter(Boolean).join(' · ') ||
              'No company or role'}
            {contact.active ? '' : ' · Inactive'}
          </p>
        </div>
        <Link
          href={`/people/${contact.partyId}`}
          className="shrink-0 rounded-md bg-muted px-2.5 py-1 text-xs font-medium hover:bg-muted/70"
        >
          Open contact
        </Link>
      </div>
      {contact.methods.length > 0 ? (
        <ul aria-label="Contact methods" className="flex flex-col gap-0.5 px-4 pb-2 text-xs">
          {contact.methods.map((method) => (
            <li key={method.id}>
              <span className="text-muted-foreground">{method.label ?? method.methodType}</span>{' '}
              {method.value}
            </li>
          ))}
        </ul>
      ) : null}
      <ul aria-label="Pitched songs" className="flex flex-col">
        {contact.pitchItems.length === 0 ? (
          <li className="px-4 pb-3 text-muted-foreground">Nothing pitched yet.</li>
        ) : (
          contact.pitchItems.map((cell) => (
            <li
              key={cell.pitchItemId}
              className="flex items-center justify-between gap-3 bg-muted/30 px-4 py-2 not-last:mb-px"
            >
              <span className="min-w-0 truncate font-medium">{cell.itemTitle}</span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {PITCH_STATUS_LABELS[cell.currentStatus]}
                {cell.followUpDue ? ' · follow-up due' : ''}
              </span>
            </li>
          ))
        )}
      </ul>
      {contact.recentMessages.length > 0 ? (
        <ul aria-label="Recent messages" className="flex flex-col gap-0.5 px-4 py-2 text-xs">
          {contact.recentMessages.map((message) => (
            <li key={message.messageId} className="truncate">
              <span className="text-muted-foreground">
                {day(message.sentAt ?? message.receivedAt ?? message.createdAt)}{' '}
                {message.direction === 'inbound' ? 'from them' : 'to them'}
              </span>{' '}
              {message.subject ?? '(no subject)'}
            </li>
          ))}
        </ul>
      ) : null}
    </ToolCard>
  );
}
