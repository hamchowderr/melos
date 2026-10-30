import Link from 'next/link';
import type { ReactNode } from 'react';
import { DetailList } from '@/components/catalog/detail-list';
import { RoleBadges } from '@/components/people/party-table';
import { Card, CardContent } from '@/components/ui/card';
import type { PartyDetailDTO } from '@/lib/dto/contacts';
import { words } from '@/lib/words';

const METHOD_TERMS = [
  ['email', 'Email'],
  ['phone', 'Phone'],
  ['url', 'Links'],
  ['social', 'Social'],
] as const;

/** A party's details at /people/[partyId] (§2.3, D-12), with stored codes as words. */
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
  const organizationType = organization?.organizationType;
  const details: [string, ReactNode][] = [
    ['Kind', party.partyKind === 'person' ? 'Person' : 'Organization'],
    ['Legal name', (person ?? organization)?.legalName],
    ['Given name', person?.givenName],
    ['Family name', person?.familyName],
    ['Organization type', organizationType ? words(organizationType) : null],
    ['Website', organization?.websiteUrl],
    ['Company', company],
    ['Contact roles', roles],
    ...METHOD_TERMS.map(([type, term]): [string, ReactNode] => [term, join(methodsOf(type))]),
    ['Aliases', join(party.aliases.map(({ aliasName }) => aliasName))],
    [
      'Identifiers',
      join(
        party.identifiers.map(({ identifierType, identifierValue, aliasName }) =>
          aliasName
            ? `${identifierType} ${identifierValue} for ${aliasName}`
            : `${identifierType} ${identifierValue}`,
        ),
      ),
    ],
    [
      'Societies',
      join(
        party.societyAffiliations.map(({ societyCode, role }) =>
          role ? `${societyCode} (${words(role)})` : societyCode,
        ),
      ),
    ],
    ['Notes', party.notes],
  ];

  return (
    <Card>
      <CardContent>
        <DetailList details={details} />
      </CardContent>
    </Card>
  );
}
