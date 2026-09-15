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

/** One live party in the /people lists. `contact` is null for a party that is not a contact. */
export type PartyListItem = {
  partyId: string;
  partyKind: PartyKind;
  displayName: string;
  primaryEmail: string | null;
  contact: PartyContactDTO | null;
};
