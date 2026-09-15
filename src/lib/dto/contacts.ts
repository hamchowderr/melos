/**
 * Party DTOs for ContactService reads (docs/CONTRACT.md §2.3 /people, §4.2; D-12). Types only, with
 * no server import, so client components can import them.
 */

export type PartyKind = 'person' | 'organization';

/** A party's live contact (§4.3; one per party, P-09) with its roles and its live company. */
export type PartyContactDTO = {
  contactId: string;
  roles: string[];
  organizationPartyId: string | null;
  organizationName: string | null;
};

/** A live person whose live contact links to an organization (§4.3 organization_party_id). */
export type LinkedPersonDTO = { partyId: string; displayName: string };

/**
 * One live party in the /people lists. `contact` is null for a party that is not a contact. Only an
 * organization carries `organizationType` (§4.2) and `people`, in name order.
 */
export type PartyListItem = {
  partyId: string;
  partyKind: PartyKind;
  displayName: string;
  primaryEmail: string | null;
  contact: PartyContactDTO | null;
  organizationType?: string | null;
  people?: LinkedPersonDTO[];
};

export type ContactMethodDTO = {
  id: string;
  methodType: string;
  label: string | null;
  value: string;
  isPrimary: boolean;
};

export type ArtistAliasDTO = {
  id: string;
  aliasName: string;
  aliasType: string;
  isPrimary: boolean;
};

/** `aliasName` names the artist alias the identifier belongs to, when it belongs to one. */
export type PartyIdentifierDTO = {
  id: string;
  identifierType: string;
  identifierValue: string;
  issuingBody: string | null;
  isPrimary: boolean;
  artistAliasId: string | null;
  aliasName: string | null;
};

export type SocietyAffiliationDTO = {
  id: string;
  societyCode: string;
  role: string | null;
  startsOn: string | null;
  endsOn: string | null;
};

/** A live party with its subtype row: `person` for a person, `organization` for an organization. */
export type PartyDetailDTO = Omit<PartyListItem, 'primaryEmail' | 'organizationType' | 'people'> & {
  notes: string | null;
  person: { givenName: string | null; familyName: string | null; legalName: string } | null;
  organization: {
    legalName: string;
    organizationType: string | null;
    websiteUrl: string | null;
  } | null;
  methods: ContactMethodDTO[];
  aliases: ArtistAliasDTO[];
  identifiers: PartyIdentifierDTO[];
  societyAffiliations: SocietyAffiliationDTO[];
};
