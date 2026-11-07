import Link from 'next/link';
import { ToolCard } from '@/components/chat/tool-card';
import type { ContactSummary } from '@/lib/dto/contacts';
import { PITCH_STATUS_LABELS, type PitchEligibilityDTO } from '@/lib/dto/pitches';

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
      <ul aria-label="Contact List" className="flex flex-col">
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

function EligibleList({
  label,
  contacts,
}: {
  label: string;
  contacts: { contactId: string; displayName: string; roles: string[]; note?: string }[];
}) {
  return (
    <div className="pb-2">
      <h4 className="px-4 pt-1 pb-1 text-xs font-medium">
        {label} ({contacts.length})
      </h4>
      {contacts.length === 0 ? (
        <p className="px-4 pb-1 text-xs text-muted-foreground">Nobody.</p>
      ) : (
        <ul aria-label={label} className="flex flex-col">
          {contacts.map((contact) => (
            <li
              key={contact.contactId}
              className="flex items-center gap-4 px-4 py-1.5 odd:bg-muted/30"
            >
              <span className="min-w-0 flex-1 truncate font-medium">{contact.displayName}</span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {[roleWords(contact.roles), contact.note].filter(Boolean).join(' · ')}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** searchPitchEligibility's ContactGrid (§3.3, CRM-006): who has not heard the song, in two lists. */
export function EligibilityGrid({ eligibility }: { eligibility: PitchEligibilityDTO }) {
  const { item, plannedNotContacted, neverPitched } = eligibility;
  return (
    <ToolCard title={`Who Hasn't Heard ${item.title}`}>
      <EligibleList
        label="Planned, not contacted"
        contacts={plannedNotContacted.map((contact) => ({
          ...contact,
          note: PITCH_STATUS_LABELS[contact.currentStatus],
        }))}
      />
      <EligibleList label="Never Pitched" contacts={neverPitched} />
    </ToolCard>
  );
}
