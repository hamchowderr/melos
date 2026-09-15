/**
 * The workspace's own parties per rights side (docs/CONTRACT.md §4.2 workspace_self_parties,
 * RGT-008). No server import, so client components can import them.
 */
import type { PartyKind } from './contacts';

export const SELF_PARTY_SIDES = ['writer', 'publishing', 'master'] as const;

export type SelfPartySide = (typeof SELF_PARTY_SIDES)[number];

/** A side's party; the writer side is always a person (§4.2). */
export type SelfPartyDTO = { partyId: string; partyKind: PartyKind; displayName: string };

/** Each side's self party, null when the side is not set. */
export type SelfPartiesDTO = Record<SelfPartySide, SelfPartyDTO | null>;

/** The full set to store: a party id for each side, or null to clear it. */
export type SelfPartiesInput = Record<SelfPartySide, string | null>;
