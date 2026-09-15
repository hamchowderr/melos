import Link from 'next/link';
import type { ReactNode } from 'react';
import { RoleBadges } from '@/components/people/party-table';
import { Card, CardContent } from '@/components/ui/card';
import type { PartyDetailDTO } from '@/lib/dto/contacts';

const METHOD_TERMS = [
  ['email', 'Email'],
  ['phone', 'Phone'],
  ['url', 'Links'],
  ['social', 'Social'],
] as const;

/** A party's details at /people/[partyId] (§2.3, D-12); a term without a value is left out. */
export function PartyDetails({ party }: { party: PartyDetailDTO }) {
  const { person, organization, contact } = party;
  const join = (values: string[]) => values.join(', ');
  const methodsOf = (type: string) =>
    party.methods.filter(({ methodType }) => methodType === type).map(({ value }) => value);
  const company = contact?.organizationPartyId ? (
    <Link href={`/people/${contact.organizationPartyId}`} className="hover:underline">
      {contact.organizationName}
    </Link>
  ) : null;
  const roles = contact?.roles.length ? <RoleBadges roles={contact.roles} /> : null;
  const details: [string, ReactNode][] = [
    ['Kind', party.partyKind === 'person' ? 'Person' : 'Organization'],
    ['Legal name', (person ?? organization)?.legalName],
    ['Given name', person?.givenName],
    ['Family name', person?.familyName],
    ['Organization type', organization?.organizationType],
    ['Website', organization?.websiteUrl],
    ['Company', company],
    ['Contact roles', roles],
    ...METHOD_TERMS.map(([type, term]): [string, ReactNode] => [term, join(methodsOf(type))]),
    ['Aliases', join(party.aliases.map(({ aliasName }) => aliasName))],
    [
      'Identifiers',
      join(
        party.identifiers.map(({ identifierType, identifierValue, aliasName }) =>
          [identifierType, identifierValue, aliasName ? `(${aliasName})` : ''].join(' ').trim(),
        ),
      ),
    ],
    [
      'Societies',
      join(
        party.societyAffiliations.map(({ societyCode, role }) =>
          [societyCode, role].join(' ').trim(),
        ),
      ),
    ],
    ['Notes', party.notes],
  ];
  const shown = details.filter(
    ([, value]) => value !== null && value !== undefined && value !== '',
  );

  return (
    <Card>
      <CardContent>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          {shown.map(([term, value]) => (
            <div key={term} className="contents">
              <dt className="text-muted-foreground">{term}</dt>
              <dd className="min-w-0">{value}</dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}
