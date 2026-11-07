/**
 * Pitch DTOs and the §6.4 status vocabulary for PitchService (docs/CONTRACT.md §3.4, §6.4, §6.10).
 * Types and pure rules only, with no server import, so client components can import them.
 */

/** `pitch_items.current_status` codes (§6.4, P-02). Status lives on one song × contact cell. */
export const PITCH_STATUSES = [
  'draft',
  'not_contacted',
  'sent',
  'awaiting_reply',
  'responded',
  'interested',
  'requested_more',
  'passed',
  'accepted',
  'closed_won',
  'closed_lost',
  'archived',
] as const;

export type PitchStatus = (typeof PITCH_STATUSES)[number];

/** UI labels (§6.4). */
export const PITCH_STATUS_LABELS: Record<PitchStatus, string> = {
  draft: 'Draft',
  not_contacted: "Hasn't heard",
  sent: 'Pitched',
  awaiting_reply: 'Awaiting reply',
  responded: 'Responded',
  interested: 'Interested',
  requested_more: 'Requested more info',
  passed: 'Passed',
  accepted: 'Accepted',
  closed_won: 'Won',
  closed_lost: 'Lost',
  archived: 'Archived',
};

/**
 * Allowed status transitions (§6.4, CRM-004). `archived` returns only to the status the cell held
 * before it was archived (unarchive), which PitchService reads from the cell's events.
 */
export const PITCH_TRANSITIONS: Record<Exclude<PitchStatus, 'archived'>, readonly PitchStatus[]> = {
  draft: ['not_contacted', 'sent', 'archived'],
  not_contacted: ['sent', 'archived'],
  sent: [
    'awaiting_reply',
    'responded',
    'interested',
    'requested_more',
    'passed',
    'closed_lost',
    'archived',
  ],
  awaiting_reply: [
    'responded',
    'interested',
    'requested_more',
    'passed',
    'closed_lost',
    'archived',
  ],
  responded: [
    'awaiting_reply',
    'interested',
    'requested_more',
    'passed',
    'closed_lost',
    'archived',
  ],
  interested: ['awaiting_reply', 'requested_more', 'accepted', 'passed', 'closed_lost', 'archived'],
  requested_more: ['awaiting_reply', 'interested', 'accepted', 'passed', 'closed_lost', 'archived'],
  accepted: ['closed_won', 'closed_lost', 'archived'],
  passed: ['interested', 'requested_more', 'archived'],
  closed_won: ['archived'],
  closed_lost: ['archived'],
};

/** Terminal statuses an agent may set only after approval (P-07). */
export const TERMINAL_STATUSES: readonly PitchStatus[] = ['closed_won', 'closed_lost', 'archived'];

/** Statuses whose cells can be due for a follow-up (§6.4 followUpDue). */
export const FOLLOW_UP_STATUSES: readonly PitchStatus[] = [
  'sent',
  'awaiting_reply',
  'responded',
  'interested',
  'requested_more',
];

/** Contact role rank (§3.7): these roles first, in this order, then every other role. */
export const ROLE_RANK = [
  'licensing_agent',
  'music_supervisor',
  'music_library',
  'ad_agency',
  'record_label',
] as const;

/** A contact's best role rank: the index of its highest-ranked role, or ROLE_RANK.length. */
export function roleRankOf(roles: readonly string[]): number {
  const ranks = roles.map((role) => ROLE_RANK.indexOf(role as (typeof ROLE_RANK)[number]));
  return Math.min(ROLE_RANK.length, ...ranks.filter((rank) => rank >= 0));
}

/**
 * followUpDue(D) (§6.4) for a cell, given `end(D)`: the last instant of D in the member's timezone,
 * as an ISO timestamp. Stored timestamps are ISO strings, so they compare as text.
 */
export function followUpDue(
  cell: {
    currentStatus: PitchStatus;
    nextFollowUpAt: string | null;
    lastContactedAt: string | null;
  },
  endOfDay: string,
): boolean {
  const { currentStatus, nextFollowUpAt, lastContactedAt } = cell;
  return (
    nextFollowUpAt !== null &&
    nextFollowUpAt <= endOfDay &&
    (lastContactedAt === null || nextFollowUpAt > lastContactedAt) &&
    FOLLOW_UP_STATUSES.includes(currentStatus)
  );
}

export type PitchItemType = 'composition' | 'recording';

/**
 * PitchSummary (§3.4): one song × contact cell with its pitch's follow-up dates. `followUpDue` is
 * for the requested date, today in the member's timezone by default. `lastOutboundMessageId` is the
 * pitch's latest sent outbound message. `priorityRank` is set only inside TodayWorkspaceDTO.
 */
export type PitchSummary = {
  pitchId: string;
  pitchItemId: string;
  contactId: string;
  contactName: string;
  contactRoles: string[];
  itemType: PitchItemType;
  itemId: string;
  itemTitle: string;
  currentStatus: PitchStatus;
  nextFollowUpAt: string | null;
  followUpDue: boolean;
  lastContactedAt: string | null;
  lastOutboundMessageId: string | null;
  priorityRank: number | null;
};

/** One immutable pitch_events row (§4.3); `metadata` is its parsed metadata_json. */
export type PitchEventDTO = {
  eventId: string;
  pitchItemId: string | null;
  eventType: string;
  fromStatus: PitchStatus | null;
  toStatus: PitchStatus | null;
  actorType: 'user' | 'agent' | 'system' | 'import';
  note: string | null;
  metadata: Record<string, unknown> | null;
  occurredAt: string;
};

/** A message on a pitch, without its body; getMessageThread returns bodies (OUT-003). */
export type PitchMessageDTO = {
  messageId: string;
  direction: 'outbound' | 'inbound';
  purpose: 'initial' | 'follow_up' | 'reply' | null;
  status: 'draft' | 'queued' | 'sending' | 'sent' | 'failed' | 'received';
  subject: string | null;
  inReplyToMessageId: string | null;
  sentAt: string | null;
  receivedAt: string | null;
  createdAt: string;
};

/**
 * PitchDTO (§3.4): one pitch to one contact (§6.10) with every cell in sort order, its events and
 * messages in time order. `followUpDue` is true when any cell is due on the requested date.
 */
export type PitchDTO = {
  pitchId: string;
  contactId: string;
  contactName: string;
  subject: string | null;
  items: PitchSummary[];
  nextFollowUpAt: string | null;
  followUpDue: boolean;
  lastContactedAt: string | null;
  events: PitchEventDTO[];
  messages: PitchMessageDTO[];
};

/**
 * searchPitches filters (§3.3). A composition item covers the cells on its recordings too.
 * Archived cells are left out unless `statuses` names `archived`. `followUpDueOn` keeps only the
 * cells due on that date (YYYY-MM-DD in the member's timezone) and computes `followUpDue` for it.
 */
export type PitchSearch = {
  statuses?: PitchStatus[];
  contactId?: string;
  itemType?: PitchItemType;
  itemId?: string;
  followUpDueOn?: string;
};

/** One song in a pitch: a composition or a recording (§6.10). */
export type PitchItemInput = { itemType: PitchItemType; itemId: string };

/** createPitch input (§3.3): one contact, 1..n songs, an optional subject and opening note. */
export type CreatePitchInput = {
  contactId: string;
  items: PitchItemInput[];
  subject?: string | null;
  note?: string | null;
};

/** transitionPitchStatus input (§3.3): one cell, its new status, a note and a follow-up date. */
export type TransitionInput = {
  pitchItemId: string;
  toStatus: PitchStatus;
  note?: string | null;
  nextFollowUpAt?: string | null;
};

/** addPitchNote input (§3.3): a note on a pitch, or on one of its cells, and a follow-up date. */
export type PitchNoteInput = {
  pitchId: string;
  note: string;
  pitchItemId?: string | null;
  nextFollowUpAt?: string | null;
};

/** A contact in a PitchEligibilityDTO list (§3.4). */
export type EligibleContact = { contactId: string; displayName: string; roles: string[] };

/**
 * PitchEligibilityDTO (§3.4, CRM-006): the active contacts who have not heard a song (P-36), by
 * role rank then name: those with a planned cell, and everyone else.
 */
export type PitchEligibilityDTO = {
  item: { itemType: PitchItemType; itemId: string; title: string };
  plannedNotContacted: (EligibleContact & {
    pitchId: string;
    pitchItemId: string;
    currentStatus: PitchStatus;
  })[];
  neverPitched: EligibleContact[];
};

/** Cells counted open for ContactSummary.openItemCount: not passed, won, lost or archived. */
export const CLOSED_STATUSES: readonly PitchStatus[] = [
  'passed',
  'closed_won',
  'closed_lost',
  'archived',
];
