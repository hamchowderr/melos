# Northstar demo fixture: expected outputs

Expected derived outputs for `northstar-demo.json` (beads `melos-73v`). `validate.mjs` asserts every table marked `<!-- check:... -->` with SQL against a fresh workspace database built from the `docs/CONTRACT.md` DDL. Nothing in this file is stored in the fixture.

Records are named by the keys in `northstar-demo.json` `keys`. Prefixed keys (`cmp_OCEAN`) follow the placeholders in CONTRACT §5.6. Tables whose DDL gives no id prefix use `<table>:<NAME>` keys and bare ULIDs.

## Demo clock

- Demo date: **2026-09-14**, member timezone **America/Los_Angeles** (Jordan Taylor, `workspace_member_settings`).
- `end(D)` for the demo date (§6.4): `2026-09-15T06:59:59.999Z`, the last millisecond of 2026-09-14 in PDT.
- Every fixture timestamp is anchored on the demo date. A seeder on another day shifts all of them by the same number of whole days (`dateShift` in the fixture), and every table below still holds for that day.

## Rules used

- **Totals**: the contract views `composition_writer_totals`, `composition_publishing_totals`, `recording_master_totals`.
- **Readiness**: CONTRACT §6.5 with P-28. Self parties: writer `pty_JORDAN`, publishing `pty_SILVERLINE`, master `pty_SILVERLINE`. No explicit licensing contacts, agreements or attestations are seeded.
- **Has heard** (§3.7, P-36): a contact has heard a song when one of their cells on the composition or on any of its recordings has a status other than `draft` or `not_contacted`. An `archived` cell counts only when the status it was archived from counts, and a cell archived from `draft` or `not_contacted` counts as no cell at all. `plannedNotContacted` = contacts with a counted cell on the song who have not heard it; `neverPitched` = every other active contact. Both lists are ordered by role rank, then display name.
- **Follow-up due** (§6.4 `followUpDue(D)`): status in `sent`, `awaiting_reply`, `responded`, `interested`, `requested_more`; `next_follow_up_at` at or before `end(D)`; and `next_follow_up_at` later than `last_contacted_at` (or `last_contacted_at` is NULL). Priority (P-31): days overdue (demo date minus the local date of `next_follow_up_at`), most first; status rank `requested_more`, `interested`, `responded`, `awaiting_reply`, `sent`; contact role rank; `next_follow_up_at`; pitch item id.
- **Stored projections** (§1.4), checked as invariants: `pitch_items.current_status` is the `to_status` of the cell's latest `status_changed` event; `pitches.last_contacted_at` is the latest `message_sent`, `call` or `meeting` event; `pitches.next_follow_up_at` is the latest sent outbound message's `sent_at` plus `workspace_settings.follow_up_interval_days` (7, P-39).
- **Search** (§3.5): exact normalized title or alternate title first, then FTS5 with the MATCH expression shown. `catalog_search` is derived from catalog rows at load time, the way `CatalogService` maintains it; the fixture does not store it. `searchContacts` matches the query as a case-insensitive substring of the contact's display name, organization name or email address. Writer resolution matches the writer's display name the same way.

## 1. Rights totals

Every total is complete except the two below, each kept incomplete on purpose for the demos named.

<!-- check:totals -->
| Song | Composition | Recording | Writer total bp | Writers | Territory | Publishing total bp | Publishers | Master total bp | Owners | Complete | Relied on by |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Midnight Drive | `cmp_MIDNIGHT` | `rec_MIDNIGHT` | 10000 | 1 | WORLD | 10000 | 1 | 10000 | 1 | yes | — |
| Ocean Blue | `cmp_OCEAN` | `rec_OCEAN` | 10000 | 2 | WORLD | 8500 | 2 | 10000 | 1 | no | DEMO-003, DEMO-004 (publishing 8500) |
| Neon Static | `cmp_NEON` | `rec_NEON` | 10000 | 2 | WORLD | 10000 | 2 | 7500 | 1 | no | DEMO-003 (master 7500) |
| Home Again | `cmp_HOME` | `rec_HOME` | 10000 | 1 | WORLD | 10000 | 1 | 10000 | 1 | yes | — |
| Paper Planes at 2AM | `cmp_PAPER` | `rec_PAPER` | 10000 | 1 | WORLD | 10000 | 1 | 10000 | 1 | yes | — |

Share rows behind the totals. Ocean Blue writers are 5000/5000, not FX's 60/40, so DEMO-008 changes data (§2.6, §5.6).

<!-- check:holders -->
| Song | Side | Party | Holder | Share bp | Roles | Self party | Attested |
|---|---|---|---|---|---|---|---|
| Midnight Drive | writer | `pty_JORDAN` | Jordan Taylor | 10000 | songwriter | yes | — |
| Midnight Drive | publishing WORLD | `pty_SILVERLINE` | Silverline Songs | 10000 | — | yes | no |
| Midnight Drive | master | `pty_SILVERLINE` | Silverline Songs | 10000 | — | yes | no |
| Ocean Blue | writer | `pty_ALEX` | Alex Ramirez | 5000 | songwriter | no | — |
| Ocean Blue | writer | `pty_JORDAN` | Jordan Taylor | 5000 | songwriter | yes | — |
| Ocean Blue | publishing WORLD | `pty_NIGHTSHIFT` | Nightshift Audio | 2500 | — | no | no |
| Ocean Blue | publishing WORLD | `pty_SILVERLINE` | Silverline Songs | 6000 | — | yes | no |
| Ocean Blue | master | `pty_SILVERLINE` | Silverline Songs | 10000 | — | yes | no |
| Neon Static | writer | `pty_ALEX` | Alex Ramirez | 5000 | songwriter | no | — |
| Neon Static | writer | `pty_JORDAN` | Jordan Taylor | 5000 | songwriter | yes | — |
| Neon Static | publishing WORLD | `pty_NIGHTSHIFT` | Nightshift Audio | 5000 | — | no | no |
| Neon Static | publishing WORLD | `pty_SILVERLINE` | Silverline Songs | 5000 | — | yes | no |
| Neon Static | master | `pty_NIGHTSHIFT` | Nightshift Audio | 7500 | — | no | no |
| Home Again | writer | `pty_JORDAN` | Jordan Taylor | 10000 | songwriter | yes | — |
| Home Again | publishing WORLD | `pty_SILVERLINE` | Silverline Songs | 10000 | — | yes | no |
| Home Again | master | `pty_SILVERLINE` | Silverline Songs | 10000 | — | yes | no |
| Paper Planes at 2AM | writer | `pty_JORDAN` | Jordan Taylor | 10000 | songwriter | yes | — |
| Paper Planes at 2AM | publishing WORLD | `pty_SILVERLINE` | Silverline Songs | 10000 | — | yes | no |
| Paper Planes at 2AM | master | `pty_SILVERLINE` | Silverline Songs | 10000 | — | yes | no |

## 2. One-stop and sync readiness

Codes are listed in the order of the CONTRACT §6.5 code tables. Sync-only codes are evaluated for every recording.

<!-- check:readiness -->
| Song | Recording | One-stop codes | Sync-only codes | Warnings | oneStopReady | syncReady | Licensing contact |
|---|---|---|---|---|---|---|---|
| Midnight Drive | `rec_MIDNIGHT` | none | none | NOT_REGISTERED_PRO, NOT_REGISTERED_MLC, NOT_REGISTERED_SOUNDEXCHANGE, NO_INSTRUMENTAL | true | true | `pty_SILVERLINE` (implicit) |
| Ocean Blue | `rec_OCEAN` | PUBLISHING_TOTAL_INCOMPLETE, PUBLISHING_NOT_CONTROLLED, NO_LICENSING_CONTACT | MISSING_ISRC | NOT_REGISTERED_PRO, NOT_REGISTERED_MLC, NOT_REGISTERED_SOUNDEXCHANGE, NO_INSTRUMENTAL | false | false | none |
| Neon Static | `rec_NEON` | MASTER_TOTAL_INCOMPLETE, PUBLISHING_NOT_CONTROLLED, MASTER_NOT_CONTROLLED, NO_LICENSING_CONTACT | none | NOT_REGISTERED_PRO, NOT_REGISTERED_MLC, NOT_REGISTERED_SOUNDEXCHANGE, NO_INSTRUMENTAL | false | false | none |
| Home Again | `rec_HOME` | none | none | NOT_REGISTERED_PRO, NOT_REGISTERED_MLC, NOT_REGISTERED_SOUNDEXCHANGE, NO_INSTRUMENTAL | true | true | `pty_SILVERLINE` (implicit) |
| Paper Planes at 2AM | `rec_PAPER` | none | none | NOT_REGISTERED_PRO, NOT_REGISTERED_MLC, NOT_REGISTERED_SOUNDEXCHANGE, NO_INSTRUMENTAL | true | true | `pty_SILVERLINE` (implicit) |

`validate.mjs` also compares these rows with the expected readiness table in CONTRACT §6.5 and with FX `oneStopReady`.

## 3. Heard and not heard

Every active contact against every song. The composition-level and recording-level rollups agree for every song, because each song has one recording; `pti_NEON_MAYA` is a composition cell and counts for `rec_NEON`.

<!-- check:heard -->
| Song | Contact | Cells | Heard | List | Position |
|---|---|---|---|---|---|
| Midnight Drive | `con_REBECCA` | `pti_MIDNIGHT_REBECCA` sent | yes | heard | — |
| Midnight Drive | `con_MAYA` | `pti_MIDNIGHT_MAYA` awaiting_reply | yes | heard | — |
| Midnight Drive | `con_MALIK` | none | no | neverPitched | 1 |
| Midnight Drive | `con_THEO` | `pti_MIDNIGHT_THEO` archived (from sent) | yes | heard | — |
| Ocean Blue | `con_REBECCA` | `pti_OCEAN_REBECCA` archived (from not_contacted) | no | neverPitched | 1 |
| Ocean Blue | `con_MAYA` | none | no | neverPitched | 2 |
| Ocean Blue | `con_MALIK` | none | no | neverPitched | 3 |
| Ocean Blue | `con_THEO` | `pti_OCEAN_THEO` not_contacted | no | plannedNotContacted | 1 |
| Neon Static | `con_REBECCA` | `pti_NEON_REBECCA` interested | yes | heard | — |
| Neon Static | `con_MAYA` | `pti_NEON_MAYA` requested_more | yes | heard | — |
| Neon Static | `con_MALIK` | `pti_NEON_MALIK` sent | yes | heard | — |
| Neon Static | `con_THEO` | none | no | neverPitched | 1 |
| Home Again | `con_REBECCA` | none | no | neverPitched | 1 |
| Home Again | `con_MAYA` | `pti_HOME_MAYA` not_contacted | no | plannedNotContacted | 1 |
| Home Again | `con_MALIK` | none | no | neverPitched | 2 |
| Home Again | `con_THEO` | `pti_HOME_THEO` not_contacted | no | plannedNotContacted | 2 |
| Paper Planes at 2AM | `con_REBECCA` | `pti_PAPER_REBECCA` awaiting_reply | yes | heard | — |
| Paper Planes at 2AM | `con_MAYA` | none | no | neverPitched | 1 |
| Paper Planes at 2AM | `con_MALIK` | `pti_PAPER_MALIK` passed | yes | heard | — |
| Paper Planes at 2AM | `con_THEO` | `pti_PAPER_THEO` sent | yes | heard | — |

Role ranks: `con_REBECCA` licensing_agent (1); `con_MAYA`, `con_THEO` music_supervisor (2); `con_MALIK` record_label (5).

## 4. Follow-ups due on 2026-09-14

<!-- check:due -->
| Rank | Pitch item | Pitch | Contact | Song | Level | Status | next_follow_up_at | last_contacted_at | Days overdue | Note |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `pti_PAPER_REBECCA` | `pit_PAPER_REBECCA` | `con_REBECCA` | Paper Planes at 2AM | recording | awaiting_reply | 2026-09-11T18:00:00.000Z | 2026-09-04T18:00:00.000Z | 3 | Beats rank 2 on role rank, although rank 2 has the earlier follow-up time. |
| 2 | `pti_MIDNIGHT_MAYA` | `pit_MIDNIGHT_MAYA` | `con_MAYA` | Midnight Drive | recording | awaiting_reply | 2026-09-11T16:00:00.000Z | 2026-09-04T16:00:00.000Z | 3 | Beats rank 3 on status rank, although rank 3 has a better role rank and an earlier time. |
| 3 | `pti_MIDNIGHT_REBECCA` | `pit_MIDNIGHT_REBECCA` | `con_REBECCA` | Midnight Drive | recording | sent | 2026-09-11T15:00:00.000Z | 2026-09-04T15:00:00.000Z | 3 | Beats rank 4 on days overdue, although rank 4 has the best status rank. |
| 4 | `pti_NEON_MAYA` | `pit_NEON_MAYA` | `con_MAYA` | Neon Static | composition | requested_more | 2026-09-15T03:00:00.000Z | 2026-09-08T03:00:00.000Z | 0 | Due: 20:00 PDT on the demo date, although its UTC date is 2026-09-15. Beats rank 5 on status rank. |
| 5 | `pti_NEON_REBECCA` | `pit_NEON_REBECCA` | `con_REBECCA` | Neon Static | recording | interested | 2026-09-14T16:00:00.000Z | 2026-09-07T16:00:00.000Z | 0 | `interested` is due. Below rank 4 on status rank, although it has the better role rank and the earlier time. |

Cells that are not due, with the first rule each one fails (`status`, `no_follow_up`, `after_date`, `contacted_since`):

<!-- check:not-due -->
| Pitch item | Contact | Song | Status | next_follow_up_at | last_contacted_at | Reason |
|---|---|---|---|---|---|---|
| `pti_MIDNIGHT_THEO` | `con_THEO` | Midnight Drive | archived | 2026-08-27T17:00:00.000Z | 2026-08-20T17:00:00.000Z | status |
| `pti_OCEAN_REBECCA` | `con_REBECCA` | Ocean Blue | archived | none | none | status |
| `pti_PAPER_MALIK` | `con_MALIK` | Paper Planes at 2AM | passed | 2026-09-04T17:00:00.000Z | 2026-08-28T17:00:00.000Z | status |
| `pti_NEON_MALIK` | `con_MALIK` | Neon Static | sent | 2026-09-08T17:00:00.000Z | 2026-09-10T18:00:00.000Z | contacted_since |
| `pti_PAPER_THEO` | `con_THEO` | Paper Planes at 2AM | sent | 2026-09-15T09:00:00.000Z | 2026-09-08T09:00:00.000Z | after_date |
| `pti_HOME_MAYA` | `con_MAYA` | Home Again | not_contacted | none | none | status |
| `pti_HOME_THEO` | `con_THEO` | Home Again | not_contacted | none | none | status |
| `pti_OCEAN_THEO` | `con_THEO` | Ocean Blue | not_contacted | none | none | status |

## 5. Search

<!-- check:search -->
| Demo | Tool | Query | MATCH expression | Results | matchType | primaryRecordingId |
|---|---|---|---|---|---|---|
| DEMO-001, READ-VS-001 | searchMusic | Midnight Drive | `"Midnight" "Drive"*` | `cmp_MIDNIGHT` | exact_title | `rec_MIDNIGHT` |
| DEMO-004, DEMO-008 | searchMusic | Ocean Blue | `"Ocean" "Blue"*` | `cmp_OCEAN` | exact_title | `rec_OCEAN` |
| DEMO-005 | searchMusic | Home Again | `"Home" "Again"*` | `cmp_HOME` | exact_title | `rec_HOME` |
| DEMO-006 | searchMusic | Paper Planes at 2AM | `"Paper" "Planes" "at" "2AM"*` | `cmp_PAPER` | exact_title | `rec_PAPER` |
| DEMO-006 | searchMusic | Paper Planes | `"Paper" "Planes"*` | `cmp_PAPER` | exact_alt_title | `rec_PAPER` |
| DEMO-006 | searchContacts | Rebecca | — | `con_REBECCA` | — | — |
| CRM-001 (email match) | searchContacts | bluelantern | — | `con_THEO` | — | — |
| DEMO-008 | writers of `cmp_OCEAN` | Alex | — | `pty_ALEX` | — | — |

Each query returns exactly one result, so no demo renders `ConflictResolver` (CAT-INT-009).

## 6. Demo facts

<!-- check:facts -->
| Demo | Fact | Expected |
|---|---|---|
| READ-VS-001 | members `organization:NORTHSTAR` | `usr_JORDAN` owner |
| READ-VS-001 | workspace `organization:NORTHSTAR` | `ws_NORTHSTAR` active |
| DEMO-001 | identifiers `cmp_MIDNIGHT` | T9000000010, `rec_MIDNIGHT` USDMO2600001 |
| DEMO-001 | primary_link `rec_MIDNIGHT` | `lnk_MIDNIGHT` https://media.example/midnight-drive from 42000 |
| DEMO-001 | pitch_counts `cmp_MIDNIGHT` | archived 1, awaiting_reply 1, sent 1 |
| DEMO-002 | writers `cmp_MIDNIGHT` | `pty_JORDAN` songwriter 10000 |
| DEMO-003 | not_sync_ready | `rec_NEON`, `rec_OCEAN` |
| DEMO-004 | publishing_total `cmp_OCEAN` WORLD | 8500 |
| DEMO-005 | planned_not_contacted `cmp_HOME` | `con_MAYA`, `con_THEO` |
| DEMO-005 | never_pitched `cmp_HOME` | `con_REBECCA`, `con_MALIK` |
| DEMO-006 | cells `con_REBECCA` `cmp_PAPER` | `pti_PAPER_REBECCA` `pit_PAPER_REBECCA` awaiting_reply |
| DEMO-006 | last_outbound `pit_PAPER_REBECCA` | `msg_PAPER_1` |
| DEMO-006 | message `msg_PAPER_1` | outbound initial sent 2026-09-04T18:00:00.000Z |
| DEMO-006 | subject `msg_PAPER_1` | Paper Planes at 2AM: one-stop track for sync |
| DEMO-006 | has_body `msg_PAPER_1` | true |
| DEMO-006 | recipients `msg_PAPER_1` | from jordan@silverline.example, to rebecca@cartersync.example |
| DEMO-007 | default_recipient `pit_PAPER_REBECCA` | `contact_methods:REBECCA_EMAIL` rebecca@cartersync.example |
| DEMO-007 | follow_up_interval | 7 |
| DEMO-007 | queue_after_send `pit_PAPER_REBECCA` 2026-09-14T17:00:00.000Z | `pti_MIDNIGHT_MAYA`, `pti_MIDNIGHT_REBECCA`, `pti_NEON_MAYA`, `pti_NEON_REBECCA` |
| DEMO-008 | writers `cmp_OCEAN` | `pty_ALEX` songwriter 5000, `pty_JORDAN` songwriter 5000 |
| DEMO-008 | rebalance `cmp_OCEAN` `pty_ALEX` 4000 | `pty_ALEX` 4000, `pty_JORDAN` 6000 |
| DEMO-008 | apply_writer_shares `cmp_OCEAN` `pty_ALEX`=4000 `pty_JORDAN`=6000 | changed 2, writer_total_bp 10000 |
| DEMO-009 | template sans_lyrics | `tpl_SANS_LYRICS` on core, rights, creators, composition, recording, metadata, listen, licensing; off lyrics |
| DEMO-009 | report_item `cmp_OCEAN` | `rec_OCEAN` |
| DEMO-009 | has_lyrics `cmp_OCEAN` | true |
| DEMO-010 | timezone `usr_JORDAN` | America/Los_Angeles |
| DEMO-010 | due_queue 2026-09-14 | `pti_PAPER_REBECCA`, `pti_MIDNIGHT_MAYA`, `pti_MIDNIGHT_REBECCA`, `pti_NEON_MAYA`, `pti_NEON_REBECCA` |
| WRITE-VS-001 | audit_rows | 0 |
| WRITE-VS-001 | other_workspace `cmp_OCEAN` | NOT_FOUND |

`apply_writer_shares` and `queue_after_send` run in a transaction that `validate.mjs` rolls back.

## 7. Demo map

<!-- check:demos -->
| Demo | Records | Expected result |
|---|---|---|
| DEMO-001 | `cmp_MIDNIGHT`, `rec_MIDNIGHT`, `lnk_MIDNIGHT`, `pty_JORDAN`, `pti_MIDNIGHT_REBECCA`, `pti_MIDNIGHT_MAYA`, `pti_MIDNIGHT_THEO` | `searchMusic` returns one `exact_title` result with `primaryRecordingId` `rec_MIDNIGHT` (§5). `MusicWorkspaceCard` shows ISWC T9000000010, ISRC USDMO2600001, the primary link from 42000 ms, `oneStopReady` and `syncReady` true (§2), and pitch counts archived 1, awaiting_reply 1, sent 1 (§6). |
| DEMO-002 | `cmp_MIDNIGHT`, `ctr_MIDNIGHT_JORDAN`, `pty_JORDAN` | Writers: `pty_JORDAN`, songwriter, 10000; `writerTotalBp` 10000 (§1). |
| DEMO-003 | `rec_MIDNIGHT`, `rec_OCEAN`, `rec_NEON`, `rec_HOME`, `rec_PAPER`, `workspace_self_parties` rows | `syncReady` is false for `rec_NEON` and `rec_OCEAN` only, with the codes in §2. |
| DEMO-004 | `cmp_OCEAN`, `rec_OCEAN`, `publishing_interests:OCEAN_SILVERLINE_WORLD`, `publishing_interests:OCEAN_NIGHTSHIFT_WORLD` | WORLD publishing total 8500. Codes `PUBLISHING_TOTAL_INCOMPLETE`, `PUBLISHING_NOT_CONTROLLED`, `NO_LICENSING_CONTACT`; sync adds `MISSING_ISRC` (§2). |
| DEMO-005 | `cmp_HOME`, `rec_HOME`, `pti_HOME_MAYA`, `pti_HOME_THEO`, `con_MAYA`, `con_THEO`, `con_REBECCA`, `con_MALIK` | plannedNotContacted: `con_MAYA`, `con_THEO`. neverPitched: `con_REBECCA`, `con_MALIK` (§3). |
| DEMO-006 | `con_REBECCA`, `cmp_PAPER`, `rec_PAPER`, `composition_alt_titles:PAPER`, `pit_PAPER_REBECCA`, `pti_PAPER_REBECCA`, `msg_PAPER_1`, `contact_methods:REBECCA_EMAIL`, `contact_methods:JORDAN_EMAIL` | One cell, `awaiting_reply`, `lastOutboundMessageId` `msg_PAPER_1` (sent 2026-09-04T18:00:00.000Z, subject "Paper Planes at 2AM: one-stop track for sync", from Jordan to Rebecca). The follow-up draft uses subject "Re: Paper Planes at 2AM: one-stop track for sync" and `replyToMessageId` `msg_PAPER_1`. |
| DEMO-007 | the DEMO-006 draft (created during the demo), `pit_PAPER_REBECCA`, `pti_PAPER_REBECCA`, `contact_methods:REBECCA_EMAIL` | Suspends before the transport runs. On approval the message is `sent` to rebecca@cartersync.example, a `message_sent` event is written, `next_follow_up_at` becomes `sent_at` plus the workspace interval (7 days) and `last_contacted_at` becomes `sent_at`. The cell stays `awaiting_reply` (automatic moves start only from `draft` or `not_contacted`) and leaves that day's queue (§6). |
| DEMO-008 | `cmp_OCEAN`, `ctr_OCEAN_JORDAN`, `ctr_OCEAN_ALEX`, `pty_JORDAN`, `pty_ALEX` | Before: `pty_ALEX` 5000, `pty_JORDAN` 5000. One other writer, so P-29 gives `pty_JORDAN` 6000. After approval: 2 rows change, `writerTotalBp` 10000, and `audit_log` gains `writer_shares.replace` and `approval.granted` (it holds 0 rows before). |
| DEMO-009 | `cmp_OCEAN`, `rec_OCEAN`, `tpl_SANS_LYRICS` | `focusedEntity` `cmp_OCEAN` expands to `rec_OCEAN`. Preset `sans_lyrics` enables every section except `lyrics`; `cmp_OCEAN` has lyrics, so the toggle removes real content. |
| DEMO-010 | `usr_JORDAN`, all 13 pitches | Jordan's timezone is America/Los_Angeles. `followUpsDue` is the §4 queue: `pti_PAPER_REBECCA`, `pti_MIDNIGHT_MAYA`, `pti_MIDNIGHT_REBECCA`, `pti_NEON_MAYA`, `pti_NEON_REBECCA`. |
| READ-VS-001 | `usr_JORDAN`, `organization:NORTHSTAR`, `member:JORDAN`, `ws_NORTHSTAR`, and the DEMO-001 records | Jordan is the only member (role owner); the workspace is `active`; the DEMO-001 results come from that workspace database. |
| WRITE-VS-001 | `cmp_OCEAN`, `ctr_OCEAN_JORDAN`, `ctr_OCEAN_ALEX`, `pty_JORDAN`, `pty_ALEX`, `usr_JORDAN` | The DEMO-008 result, written only after approval. `cmp_OCEAN` looked up in a second, empty workspace database returns `NOT_FOUND`. |

## Fixture additions beyond FX

The eight FX pitches map to the cells in `fxCells`. The fixture adds records that the demos or these rules need:

- `pti_MIDNIGHT_THEO` (archived from `sent`, heard) and `pti_OCEAN_REBECCA` (archived from `not_contacted`, never pitched) exercise the archived rule in §3.
- `pti_NEON_REBECCA` is a due `interested` cell, so the `interested` status rank is exercised in §4.
- `pti_NEON_MAYA` is a composition-level cell. It exercises the composition rollup and is the due cell on the timezone boundary.
- `pti_PAPER_THEO` is a sent cell whose follow-up falls 2 hours after the end of the demo date.
- A sent outbound message backs every cell that has `next_follow_up_at`. `msg_PAPER_1` gives DEMO-006 its context.
- `cmp_OCEAN` has fictional lyrics, so DEMO-009's `sans_lyrics` preset removes content.
- `report_templates` (the three system presets) and the single `workspace_settings` row are what `WorkspaceProvisioner` seeds (§7.2); they and `workspace_registry` are listed in `provisionerOwned`.
