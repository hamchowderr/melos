-- Workspace schema version 1: docs/CONTRACT.md §4.2 without schema_migrations, which the runner creates.
-- ---------- Parties (ADR-013) ----------
CREATE TABLE parties (
  id            TEXT PRIMARY KEY,                             -- pty_<ulid>
  party_kind    TEXT NOT NULL CHECK (party_kind IN ('person','organization')),
  display_name  TEXT NOT NULL,
  notes         TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  created_by    TEXT,
  updated_by    TEXT,
  deleted_at    TEXT,
  UNIQUE (id, party_kind)              -- parent key for kind-checked foreign keys
);
--> statement-breakpoint
CREATE TABLE people (
  party_id     TEXT PRIMARY KEY,
  party_kind   TEXT NOT NULL DEFAULT 'person' CHECK (party_kind = 'person'),
  given_name   TEXT,
  family_name  TEXT,
  legal_name   TEXT NOT NULL,
  FOREIGN KEY (party_id, party_kind) REFERENCES parties(id, party_kind) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE organizations (
  party_id           TEXT PRIMARY KEY,
  party_kind         TEXT NOT NULL DEFAULT 'organization' CHECK (party_kind = 'organization'),
  legal_name         TEXT NOT NULL,
  organization_type  TEXT,          -- publisher, label, sync_agency, management, distributor, music_library, other
  website_url        TEXT,
  FOREIGN KEY (party_id, party_kind) REFERENCES parties(id, party_kind) ON DELETE CASCADE
);
--> statement-breakpoint
-- The parties that are "me" for this workspace, one per rights side (RGT-008, §6.5).
-- The writer side must be a person, because writer shares reference people.
CREATE TABLE workspace_self_parties (
  side        TEXT PRIMARY KEY CHECK (side IN ('writer','publishing','master')),
  party_id    TEXT NOT NULL,
  party_kind  TEXT NOT NULL CHECK (party_kind IN ('person','organization')),
  updated_at  TEXT NOT NULL,
  updated_by  TEXT,
  CHECK (side != 'writer' OR party_kind = 'person'),
  FOREIGN KEY (party_id, party_kind) REFERENCES parties(id, party_kind) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE artist_aliases (
  id          TEXT PRIMARY KEY,
  party_id    TEXT NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
  alias_name  TEXT NOT NULL,
  alias_type  TEXT NOT NULL DEFAULT 'stage_name'
              CHECK (alias_type IN ('stage_name','band_name','pseudonym','aka')),
  is_primary  INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0,1)),
  created_at  TEXT NOT NULL,
  created_by  TEXT,
  UNIQUE (party_id, alias_name)
);
--> statement-breakpoint
CREATE TABLE party_identifiers (
  id                TEXT PRIMARY KEY,
  party_id          TEXT NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
  artist_alias_id   TEXT REFERENCES artist_aliases(id) ON DELETE SET NULL,  -- an AKA can carry its own IPI
  identifier_type   TEXT NOT NULL,   -- IPI, ISNI, SOCIETY_MEMBER_ID, OTHER
  identifier_value  TEXT NOT NULL,
  issuing_body      TEXT,
  is_primary        INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0,1)),
  created_at        TEXT NOT NULL,
  created_by        TEXT,
  UNIQUE (identifier_type, identifier_value)
);
--> statement-breakpoint
CREATE TABLE party_society_affiliations (
  id            TEXT PRIMARY KEY,
  party_id      TEXT NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
  society_code  TEXT NOT NULL,       -- ASCAP, BMI, SESAC, ... not constrained (BP §11.3)
  role          TEXT CHECK (role IS NULL OR role IN ('writer','publisher')),
  starts_on     TEXT,
  ends_on       TEXT,
  created_at    TEXT NOT NULL,
  created_by    TEXT
);
--> statement-breakpoint
CREATE TABLE contact_methods (
  id           TEXT PRIMARY KEY,
  party_id     TEXT NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
  method_type  TEXT NOT NULL CHECK (method_type IN ('email','phone','url','social')),
  label        TEXT,
  value        TEXT NOT NULL,
  is_primary   INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0,1)),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  created_by   TEXT,
  updated_by   TEXT
);
--> statement-breakpoint
-- ---------- Catalog ----------
CREATE TABLE compositions (
  id                             TEXT PRIMARY KEY,           -- cmp_<ulid>
  title                          TEXT NOT NULL,
  description                    TEXT,
  lyrics                         TEXT,
  iswc                           TEXT                        -- unique among live rows: uq_compositions_iswc
                                 CHECK (iswc IS NULL OR iswc GLOB 'T[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'),
  copyright_registration_number  TEXT,
  copyright_date                 TEXT,
  notes                          TEXT,
  created_at                     TEXT NOT NULL,
  updated_at                     TEXT NOT NULL,
  created_by                     TEXT,
  updated_by                     TEXT,
  deleted_at                     TEXT
);
--> statement-breakpoint
CREATE TABLE composition_alt_titles (
  id              TEXT PRIMARY KEY,
  composition_id  TEXT NOT NULL REFERENCES compositions(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  title_type      TEXT NOT NULL DEFAULT 'alternate'
                  CHECK (title_type IN ('alternate','translated','working','short')),
  UNIQUE (composition_id, title)
);
--> statement-breakpoint
CREATE TABLE recordings (
  id                             TEXT PRIMARY KEY,           -- rec_<ulid>
  composition_id                 TEXT REFERENCES compositions(id) ON DELETE RESTRICT,
  title                          TEXT NOT NULL,
  version_title                  TEXT,
  description                    TEXT,
  isrc                           TEXT                        -- unique among live rows: uq_recordings_isrc
                                 CHECK (isrc IS NULL OR isrc GLOB '[A-Z0-9][A-Z0-9][A-Z0-9][A-Z0-9][A-Z0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'),
  duration_ms                    INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  bpm                            REAL CHECK (bpm IS NULL OR bpm > 0),
  musical_key                    TEXT,
  preview_start_ms               INTEGER CHECK (preview_start_ms IS NULL OR preview_start_ms >= 0),
  copyright_registration_number  TEXT,
  copyright_date                 TEXT,
  first_release_date             TEXT,
  notes                          TEXT,
  created_at                     TEXT NOT NULL,
  updated_at                     TEXT NOT NULL,
  created_by                     TEXT,
  updated_by                     TEXT,
  deleted_at                     TEXT
);
--> statement-breakpoint
CREATE TABLE recording_links (
  id            TEXT PRIMARY KEY,                             -- lnk_<ulid>
  recording_id  TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  link_type     TEXT NOT NULL DEFAULT 'private_player'
                CHECK (link_type IN ('private_player','dsp','cloud_file','sync_link','video','other')),
  label         TEXT,
  url           TEXT NOT NULL,
  is_primary    INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0,1)),
  created_at    TEXT NOT NULL,
  created_by    TEXT
);
--> statement-breakpoint
CREATE TABLE releases (
  id                    TEXT PRIMARY KEY,                     -- rel_<ulid>
  title                 TEXT NOT NULL,
  release_type          TEXT CHECK (release_type IS NULL OR
                                    release_type IN ('single','ep','album','compilation','other')),
  upc_ean               TEXT CHECK (upc_ean IS NULL OR
                                    (length(upc_ean) >= 8 AND upc_ean NOT GLOB '*[^0-9]*')),  -- exact lengths U-11
  label_party_id        TEXT REFERENCES parties(id) ON DELETE RESTRICT,
  distributor_party_id  TEXT REFERENCES parties(id) ON DELETE RESTRICT,
  release_date          TEXT,
  notes                 TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  created_by            TEXT,
  updated_by            TEXT,
  deleted_at            TEXT
);
--> statement-breakpoint
CREATE TABLE release_tracks (
  release_id    TEXT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  recording_id  TEXT NOT NULL REFERENCES recordings(id) ON DELETE RESTRICT,
  disc_number   INTEGER NOT NULL DEFAULT 1 CHECK (disc_number >= 1),
  track_number  INTEGER CHECK (track_number IS NULL OR track_number >= 1),
  PRIMARY KEY (release_id, recording_id),
  UNIQUE (release_id, disc_number, track_number)
);
--> statement-breakpoint
CREATE TABLE recording_artists (
  id               TEXT PRIMARY KEY,
  recording_id     TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  party_id         TEXT NOT NULL REFERENCES parties(id) ON DELETE RESTRICT,
  artist_alias_id  TEXT REFERENCES artist_aliases(id) ON DELETE SET NULL,   -- credited name
  role             TEXT NOT NULL CHECK (role IN ('primary','featured')),
  billing_order    INTEGER NOT NULL DEFAULT 0,
  UNIQUE (recording_id, party_id, role)
);
--> statement-breakpoint
CREATE TABLE recording_contributors (
  id            TEXT PRIMARY KEY,
  recording_id  TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  party_id      TEXT NOT NULL REFERENCES parties(id) ON DELETE RESTRICT,
  role          TEXT NOT NULL,   -- producer, mixing_engineer, mastering_engineer, engineer, musician, other
  credit_text   TEXT,
  UNIQUE (recording_id, party_id, role)
);
--> statement-breakpoint
CREATE TABLE metadata_terms (
  id                TEXT PRIMARY KEY,                         -- trm_<ulid>
  term_type         TEXT NOT NULL
                    CHECK (term_type IN ('genre','mood','instrument','keyword','sounds_like')),
  label             TEXT NOT NULL,
  normalized_label  TEXT NOT NULL,                            -- lowercase, trimmed
  UNIQUE (term_type, normalized_label)
);
--> statement-breakpoint
CREATE TABLE composition_terms (
  composition_id  TEXT NOT NULL REFERENCES compositions(id) ON DELETE CASCADE,
  term_id         TEXT NOT NULL REFERENCES metadata_terms(id) ON DELETE CASCADE,
  PRIMARY KEY (composition_id, term_id)
);
--> statement-breakpoint
CREATE TABLE recording_terms (
  recording_id  TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  term_id       TEXT NOT NULL REFERENCES metadata_terms(id) ON DELETE CASCADE,
  PRIMARY KEY (recording_id, term_id)
);
--> statement-breakpoint
-- ---------- Indexes on these tables (§4.3) ----------
CREATE INDEX idx_parties_kind_name        ON parties(party_kind, display_name);--> statement-breakpoint
CREATE INDEX idx_artist_aliases_party     ON artist_aliases(party_id);--> statement-breakpoint
CREATE INDEX idx_party_identifiers_party  ON party_identifiers(party_id);--> statement-breakpoint
CREATE INDEX idx_society_party            ON party_society_affiliations(party_id);--> statement-breakpoint
CREATE INDEX idx_contact_methods_party    ON contact_methods(party_id);--> statement-breakpoint
CREATE INDEX idx_contact_methods_value    ON contact_methods(method_type, value);--> statement-breakpoint
CREATE UNIQUE INDEX uq_contact_methods_primary ON contact_methods(party_id, method_type) WHERE is_primary = 1;--> statement-breakpoint
CREATE INDEX idx_compositions_title       ON compositions(title);--> statement-breakpoint
CREATE UNIQUE INDEX uq_compositions_iswc  ON compositions(iswc) WHERE iswc IS NOT NULL AND deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX idx_recordings_composition   ON recordings(composition_id);--> statement-breakpoint
CREATE INDEX idx_recordings_title         ON recordings(title);--> statement-breakpoint
CREATE UNIQUE INDEX uq_recordings_isrc    ON recordings(isrc) WHERE isrc IS NOT NULL AND deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX uq_recording_links_primary ON recording_links(recording_id) WHERE is_primary = 1;--> statement-breakpoint
CREATE UNIQUE INDEX uq_releases_upc_ean   ON releases(upc_ean) WHERE upc_ean IS NOT NULL AND deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX idx_release_tracks_recording ON release_tracks(recording_id);--> statement-breakpoint
CREATE INDEX idx_recording_artists_party  ON recording_artists(party_id);--> statement-breakpoint
CREATE INDEX idx_recording_contrib_rec    ON recording_contributors(recording_id);
