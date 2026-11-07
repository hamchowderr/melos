import Link from 'next/link';
import { ToolCard } from '@/components/chat/tool-card';
import type { ContactSummary } from '@/lib/dto/contacts';

/** A role code as words: music_supervisor as "music supervisor". */
export const roleWords = (roles: string[]) =>
  roles.map((role) => role.replace(/_/g, ' ')).join(', ');

/** searchContacts's ContactGrid (§3.3): one row per contact with company, roles and open cells. */
export function ContactGrid({ contacts }: { contacts: ContactSummary[] }) {
  const title = 'Contacts';
  if (contacts.length === 0) {
    return (
      <ToolCard title={title}>
        <p className="px-4 pb-3 text-muted-foreground">No contacts matched.</p>
      </ToolCard>
    );
  }
  return (
    <ToolCard title={title}>
      <ul aria-label="Contact list" className="flex flex-col">
        {contacts.map((contact) => (
          <li
            key={contact.contactId}
            className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 odd:bg-muted/30"
          >
            <div className="min-w-0 flex-1">
              <Link
                href={`/people/${contact.partyId}`}
                className="font-medium underline-offset-4 hover:underline"
              >
                {contact.displayName}
              </Link>
              <p className="truncate text-xs text-muted-foreground">
                {[contact.organizationName, roleWords(contact.roles), contact.primaryEmail]
                  .filter(Boolean)
                  .join(' · ') || 'No company or role'}
              </p>
            </div>
            <span className="shrink-0 text-xs text-muted-foreground">
              {contact.openItemCount === 1
                ? '1 open pitch'
                : `${contact.openItemCount} open pitches`}
            </span>
          </li>
        ))}
      </ul>
    </ToolCard>
  );
}
