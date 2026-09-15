import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { PartyListItem } from '@/lib/dto/contacts';
import { words } from '@/lib/words';

/** A contact's roles (§4.3 contact_roles), as words. */
export function RoleBadges({ roles }: { roles: string[] }) {
  return (
    <span className="flex flex-wrap gap-1">
      {roles.map((role) => (
        <Badge key={role} variant="secondary">
          {words(role)}
        </Badge>
      ))}
    </span>
  );
}

type Props = { parties: PartyListItem[]; noun: 'people' | 'organizations' };

/** People or organizations at /people (§2.3), in the order ContactService lists them. */
export function PartyTable({ parties, noun }: Props) {
  if (parties.length === 0) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyTitle>No {noun} yet</EmptyTitle>
          <EmptyDescription>The {noun} in this workspace are listed here.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Primary email</TableHead>
          <TableHead>Company</TableHead>
          <TableHead>Contact roles</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {parties.map(({ partyId, displayName, primaryEmail, contact }) => (
          <TableRow key={partyId}>
            <TableCell className="whitespace-normal">
              <Link href={`/people/${partyId}`} className="font-medium hover:underline">
                {displayName}
              </Link>
            </TableCell>
            <TableCell>{primaryEmail}</TableCell>
            <TableCell className="whitespace-normal">{contact?.organizationName}</TableCell>
            <TableCell>
              <RoleBadges roles={contact?.roles ?? []} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
