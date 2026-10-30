-- Workspace schema version 4: song registrations (docs/CONTRACT.md §4.3, CAT-010, owner decision 2026-10-30).
-- Where a composition or recording is registered and the code the registry returned.
CREATE TABLE composition_registrations (
  id              TEXT PRIMARY KEY,                           -- creg_<ulid>
  composition_id  TEXT NOT NULL REFERENCES compositions(id) ON DELETE CASCADE,
  registry_kind   TEXT NOT NULL CHECK (registry_kind IN ('pro','mlc','hfa','other')),
  society_code    TEXT,
  status          TEXT NOT NULL DEFAULT 'registered' CHECK (status IN ('pending','registered')),
  work_code       TEXT,      -- PRO work ID, MLC song code or HFA song code
  registered_on   TEXT,
  notes           TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  created_by      TEXT,
  updated_by      TEXT,
  CHECK ((registry_kind = 'pro') = (society_code IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE recording_registrations (
  id                 TEXT PRIMARY KEY,                        -- rreg_<ulid>
  recording_id       TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  registry_kind      TEXT NOT NULL CHECK (registry_kind IN ('soundexchange','other')),
  status             TEXT NOT NULL DEFAULT 'registered' CHECK (status IN ('pending','registered')),
  registration_code  TEXT,
  registered_on      TEXT,
  notes              TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  created_by         TEXT,
  updated_by         TEXT
);
--> statement-breakpoint
CREATE UNIQUE INDEX uq_composition_registrations ON composition_registrations(composition_id, registry_kind, ifnull(society_code, ''));--> statement-breakpoint
CREATE UNIQUE INDEX uq_recording_registrations   ON recording_registrations(recording_id, registry_kind);
