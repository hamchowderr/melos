'use client';

import Link from 'next/link';
import { Fragment, type ReactNode, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { GridFrame } from '@/components/ui/grid-frame';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
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

/** A table column: its heading, its cell for a party, and whether long text wraps. */
type Column = { heading: string; cell: (party: PartyListItem) => ReactNode; wrap?: boolean };

const NAME: Column = {
  heading: 'Name',
  cell: ({ partyId, displayName }) => (
    <Link href={`/people/${partyId}`} className="font-medium hover:underline">
      {displayName}
    </Link>
  ),
  wrap: true,
};
const EMAIL: Column = { heading: 'Primary email', cell: ({ primaryEmail }) => primaryEmail };

/** People list their contact's company and roles; organizations their type and linked people. */
const COLUMNS: Record<Props['noun'], Column[]> = {
  people: [
    NAME,
    EMAIL,
    { heading: 'Company', cell: ({ contact }) => contact?.organizationName, wrap: true },
    {
      heading: 'Contact roles',
      cell: ({ contact }) => <RoleBadges roles={contact?.roles ?? []} />,
    },
  ],
  organizations: [
    NAME,
    {
      heading: 'Type',
      cell: ({ organizationType }) => organizationType && words(organizationType),
    },
    {
      heading: 'People',
      cell: ({ people = [] }) =>
        people.map(({ partyId, displayName }, index) => (
          <Fragment key={partyId}>
            {index > 0 && ', '}
            <Link href={`/people/${partyId}`} className="hover:underline">
              {displayName}
            </Link>
          </Fragment>
        )),
      wrap: true,
    },
    EMAIL,
  ],
};

/** A cell's content, or a dash when it has none, so a card never shows an empty row. */
const filled = (content: ReactNode) =>
  content == null || content === '' || (Array.isArray(content) && content.length === 0)
    ? '—'
    : content;

/** One party's columns in the side panel, with the way to its full page. */
function PartyPanel({
  party,
  details,
  onClose,
}: {
  party: PartyListItem | null;
  details: Column[];
  onClose: () => void;
}) {
  return (
    <Sheet open={party !== null} onOpenChange={(open) => (open ? null : onClose())}>
      <SheetContent>
        {party ? (
          <>
            <SheetHeader className="border-b">
              <SheetTitle>{party.displayName}</SheetTitle>
              <SheetDescription>
                {party.partyKind === 'person' ? 'Person' : 'Organization'}
              </SheetDescription>
            </SheetHeader>
            <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-2 px-4">
              {details.map(({ heading, cell }) => (
                <Fragment key={heading}>
                  <dt className="text-muted-foreground">{heading}</dt>
                  <dd className="break-words">{filled(cell(party))}</dd>
                </Fragment>
              ))}
            </dl>
            <SheetFooter className="border-t">
              <Link href={`/people/${party.partyId}`} className={buttonVariants()}>
                Open {party.partyKind === 'person' ? 'person' : 'organization'}
              </Link>
            </SheetFooter>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

/** People or organizations at /people (§2.3), in the order ContactService lists them. */
export function PartyTable({ parties, noun }: Props) {
  const [open, setOpen] = useState<PartyListItem | null>(null);
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

  const [name, ...details] = COLUMNS[noun];
  return (
    <>
      {/* Phone width: one card per party, so no column is squeezed or scrolled off (rpr.48). */}
      <ul
        aria-label={noun === 'people' ? 'People' : 'Organizations'}
        className="flex flex-col gap-2 sm:hidden"
      >
        {parties.map((party) => (
          <li key={party.partyId} className="rounded-lg border p-3">
            {name.cell(party)}
            <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
              {details.map(({ heading, cell }) => (
                <Fragment key={heading}>
                  <dt className="text-muted-foreground">{heading}</dt>
                  <dd className="break-words">{filled(cell(party))}</dd>
                </Fragment>
              ))}
            </dl>
          </li>
        ))}
      </ul>
      <GridFrame className="hidden sm:block">
        <Table>
          <TableHeader>
            <TableRow>
              {[name, ...details].map(({ heading }) => (
                <TableHead key={heading}>{heading}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {parties.map((party) => (
              <TableRow
                key={party.partyId}
                className="cursor-pointer focus-visible:bg-muted/50 focus-visible:outline-none"
                // A click anywhere but a link, or Enter on the focused row, opens the side panel.
                tabIndex={0}
                aria-label={`${party.displayName} details`}
                onClick={(event) => {
                  if (!(event.target as HTMLElement).closest('a,button')) setOpen(party);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && event.target === event.currentTarget) setOpen(party);
                }}
              >
                {[name, ...details].map(({ heading, cell, wrap }) => (
                  <TableCell key={heading} className={wrap ? 'whitespace-normal' : undefined}>
                    {cell(party)}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </GridFrame>
      <PartyPanel party={open} details={details} onClose={() => setOpen(null)} />
    </>
  );
}
