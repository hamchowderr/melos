-- Workspace schema version 3: the docs/CONTRACT.md §4.3 CRM and reports objects. With versions 1 and 2
-- the workspace database holds every §4.2 and §4.3 object.
-- ---------- CRM ----------
CREATE TABLE contacts (
  id                       TEXT PRIMARY KEY,                  -- con_<ulid>
  party_id                 TEXT NOT NULL REFERENCES parties(id) ON DELETE RESTRICT,
  organization_party_id    TEXT,
  organization_party_kind  TEXT NOT NULL DEFAULT 'organization'
                           CHECK (organization_party_kind = 'organization'),
  relationship_notes       TEXT,
  active                   INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL,
  created_by               TEXT,
  updated_by               TEXT,
  deleted_at               TEXT,
  FOREIGN KEY (organization_party_id, organization_party_kind)
    REFERENCES parties(id, party_kind) ON DELETE RESTRICT
);
--> statement-breakpoint
-- role vocabulary (not constrained, extensible): licensing_agent, music_supervisor, music_library,
-- ad_agency, record_label, blogger, curator, radio, other
CREATE TABLE contact_roles (
  contact_id  TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  role        TEXT NOT NULL,
  PRIMARY KEY (contact_id, role)
);
--> statement-breakpoint
-- Workspace-level settings. Exactly one row, seeded at provisioning (§7.2).
CREATE TABLE workspace_settings (
  id                       INTEGER PRIMARY KEY CHECK (id = 1),
  follow_up_interval_days  INTEGER NOT NULL DEFAULT 7 CHECK (follow_up_interval_days BETWEEN 1 AND 365),  -- P-39
  updated_at               TEXT NOT NULL,
  updated_by               TEXT
);
--> statement-breakpoint
-- A pitch is outreach to one contact. Pitches are archived, never deleted.
CREATE TABLE pitches (
  id                 TEXT PRIMARY KEY,                        -- pit_<ulid>
  contact_id         TEXT NOT NULL REFERENCES contacts(id) ON DELETE RESTRICT,
  subject            TEXT,
  next_follow_up_at  TEXT,
  last_contacted_at  TEXT,                                    -- latest message_sent, call or meeting event
  outcome            TEXT,
  notes              TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  created_by         TEXT,
  updated_by         TEXT
);
--> statement-breakpoint
-- One song x contact cell. current_status is the projection of the latest status event (§6.4).
CREATE TABLE pitch_items (
  id              TEXT PRIMARY KEY,                           -- pti_<ulid>
  pitch_id        TEXT NOT NULL REFERENCES pitches(id) ON DELETE RESTRICT,
  composition_id  TEXT REFERENCES compositions(id) ON DELETE RESTRICT,
  recording_id    TEXT REFERENCES recordings(id) ON DELETE RESTRICT,
  current_status  TEXT NOT NULL DEFAULT 'draft'
                  CHECK (current_status IN ('draft','not_contacted','sent','awaiting_reply','responded',
                                            'interested','requested_more','passed','accepted',
                                            'closed_won','closed_lost','archived')),
  sort_order      INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  created_by      TEXT,
  updated_by      TEXT,
  CHECK ((composition_id IS NULL) != (recording_id IS NULL))
);
--> statement-breakpoint
CREATE TABLE pitch_events (
  id             TEXT PRIMARY KEY,                            -- pev_<ulid>
  pitch_id       TEXT NOT NULL REFERENCES pitches(id) ON DELETE RESTRICT,
  pitch_item_id  TEXT REFERENCES pitch_items(id) ON DELETE RESTRICT,
  event_type     TEXT NOT NULL
                 CHECK (event_type IN ('status_changed','note_added','item_added','message_sent',
                                       'message_failed','reply_received','meeting','call',
                                       'follow_up_scheduled','imported')),
  from_status    TEXT,
  to_status      TEXT,
  actor_type     TEXT NOT NULL CHECK (actor_type IN ('user','agent','system','import')),
  actor_id       TEXT,
  note           TEXT,
  metadata_json  TEXT,
  occurred_at    TEXT NOT NULL,
  CHECK (event_type != 'status_changed' OR (pitch_item_id IS NOT NULL AND to_status IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE messages (
  id                      TEXT PRIMARY KEY,                   -- msg_<ulid>
  pitch_id                TEXT REFERENCES pitches(id) ON DELETE RESTRICT,
  generated_report_id     TEXT REFERENCES generated_reports(id) ON DELETE RESTRICT,
  in_reply_to_message_id  TEXT REFERENCES messages(id) ON DELETE SET NULL,
  channel                 TEXT NOT NULL DEFAULT 'email' CHECK (channel IN ('email')),
  direction               TEXT NOT NULL CHECK (direction IN ('outbound','inbound')),
  purpose                 TEXT CHECK (purpose IS NULL OR purpose IN ('initial','follow_up','reply')),
  status                  TEXT NOT NULL
                          CHECK (status IN ('draft','queued','sending','sent','failed','received')),
  subject                 TEXT,
  body_text               TEXT,
  body_html               TEXT,
  provider                TEXT,
  provider_message_id     TEXT,
  provider_thread_id      TEXT,
  sent_at                 TEXT,
  received_at             TEXT,
  failure_reason          TEXT,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  created_by              TEXT,
  updated_by              TEXT,
  CHECK (status != 'sent' OR sent_at IS NOT NULL),
  CHECK ((direction = 'inbound') = (status = 'received')),
  CHECK (status != 'received' OR received_at IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE message_recipients (
  message_id         TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  recipient_type     TEXT NOT NULL CHECK (recipient_type IN ('from','to','cc','bcc')),
  contact_method_id  TEXT REFERENCES contact_methods(id) ON DELETE SET NULL,
  address_snapshot   TEXT NOT NULL,
  PRIMARY KEY (message_id, recipient_type, address_snapshot)
);
--> statement-breakpoint
-- ---------- Reports ----------
-- config_json: {"sections":[{"id":"core","enabled":true}, ... {"id":"lyrics","enabled":true}],
--               "format":"text" | "text_and_pdf"}. Section order is fixed by §6.12.
CREATE TABLE report_templates (
  id           TEXT PRIMARY KEY,                              -- tpl_<ulid>
  name         TEXT NOT NULL,
  report_type  TEXT NOT NULL
               CHECK (report_type IN ('metadata_package','disco_track_info','custom')),
  preset_key   TEXT UNIQUE
               CHECK (preset_key IS NULL OR preset_key IN ('full','sans_lyrics','just_lyrics','disco_track_info')),
  config_json  TEXT NOT NULL,
  is_system    INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0,1)),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  created_by   TEXT,
  updated_by   TEXT
);
--> statement-breakpoint
CREATE TABLE generated_reports (
  id                    TEXT PRIMARY KEY,                     -- rpt_<ulid>
  template_id           TEXT NOT NULL REFERENCES report_templates(id) ON DELETE RESTRICT,
  pitch_id              TEXT REFERENCES pitches(id) ON DELETE RESTRICT,
  config_snapshot_json  TEXT NOT NULL,
  content_text          TEXT NOT NULL,
  content_json          TEXT NOT NULL,
  pdf_asset_id          TEXT REFERENCES assets(id) ON DELETE RESTRICT,
  generated_at          TEXT NOT NULL,
  generated_by          TEXT
);
--> statement-breakpoint
CREATE TABLE generated_report_items (
  report_id       TEXT NOT NULL REFERENCES generated_reports(id) ON DELETE RESTRICT,
  sort_order      INTEGER NOT NULL,
  composition_id  TEXT REFERENCES compositions(id) ON DELETE RESTRICT,
  recording_id    TEXT REFERENCES recordings(id) ON DELETE RESTRICT,
  PRIMARY KEY (report_id, sort_order),
  CHECK ((composition_id IS NULL) != (recording_id IS NULL))
);
--> statement-breakpoint
-- ---------- Guards that fire on or read these tables (§4.3) ----------
CREATE TRIGGER pitch_events_no_update BEFORE UPDATE ON pitch_events
BEGIN SELECT RAISE(ABORT, 'pitch_events is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER pitch_events_no_delete BEFORE DELETE ON pitch_events
BEGIN SELECT RAISE(ABORT, 'pitch_events is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER generated_reports_no_update BEFORE UPDATE ON generated_reports
BEGIN SELECT RAISE(ABORT, 'generated_reports is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER generated_reports_no_delete BEFORE DELETE ON generated_reports
BEGIN SELECT RAISE(ABORT, 'generated_reports is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER generated_report_items_no_update BEFORE UPDATE ON generated_report_items
BEGIN SELECT RAISE(ABORT, 'generated_report_items is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER generated_report_items_no_delete BEFORE DELETE ON generated_report_items
BEGIN SELECT RAISE(ABORT, 'generated_report_items is immutable'); END;
--> statement-breakpoint
-- A pitch holds a song at one level only: a composition cell and a cell for one of its recordings
-- cannot share a pitch (§4.4). Item targets never change after insert.
CREATE TRIGGER pitch_items_one_level_recording BEFORE INSERT ON pitch_items
WHEN NEW.recording_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM pitch_items pi JOIN recordings r ON r.id = NEW.recording_id
  WHERE pi.pitch_id = NEW.pitch_id AND pi.composition_id IS NOT NULL AND pi.composition_id = r.composition_id)
BEGIN SELECT RAISE(ABORT, 'pitch already holds this song as a composition'); END;
--> statement-breakpoint
CREATE TRIGGER pitch_items_one_level_composition BEFORE INSERT ON pitch_items
WHEN NEW.composition_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM pitch_items pi JOIN recordings r ON r.id = pi.recording_id
  WHERE pi.pitch_id = NEW.pitch_id AND r.composition_id = NEW.composition_id)
BEGIN SELECT RAISE(ABORT, 'pitch already holds a recording of this composition'); END;
--> statement-breakpoint
CREATE TRIGGER pitch_items_target_immutable BEFORE UPDATE OF pitch_id, composition_id, recording_id ON pitch_items
BEGIN SELECT RAISE(ABORT, 'pitch item target is immutable'); END;
--> statement-breakpoint
-- Moving a recording to another composition must not leave a pitch holding the recording and that composition.
CREATE TRIGGER recordings_composition_change_pitch_level BEFORE UPDATE OF composition_id ON recordings
WHEN NEW.composition_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM pitch_items pr JOIN pitch_items pc ON pc.pitch_id = pr.pitch_id
  WHERE pr.recording_id = NEW.id AND pc.composition_id = NEW.composition_id)
BEGIN SELECT RAISE(ABORT, 'pitch holds this recording and its new composition'); END;
--> statement-breakpoint
-- ---------- Indexes on these tables (§4.3) ----------
CREATE UNIQUE INDEX uq_contacts_party_active ON contacts(party_id) WHERE deleted_at IS NULL;   -- P-09
--> statement-breakpoint
CREATE INDEX idx_contact_roles_role       ON contact_roles(role);--> statement-breakpoint
CREATE INDEX idx_pitches_contact          ON pitches(contact_id);--> statement-breakpoint
CREATE INDEX idx_pitches_follow_up        ON pitches(next_follow_up_at) WHERE next_follow_up_at IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX uq_pitch_items_recording   ON pitch_items(pitch_id, recording_id)   WHERE recording_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX uq_pitch_items_composition ON pitch_items(pitch_id, composition_id) WHERE composition_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX idx_pitch_items_recording_status  ON pitch_items(recording_id, current_status);--> statement-breakpoint
CREATE INDEX idx_pitch_items_composition_status ON pitch_items(composition_id, current_status);--> statement-breakpoint
CREATE INDEX idx_pitch_events_pitch_time  ON pitch_events(pitch_id, occurred_at DESC);--> statement-breakpoint
CREATE INDEX idx_messages_pitch_time      ON messages(pitch_id, created_at DESC);--> statement-breakpoint
CREATE UNIQUE INDEX uq_messages_provider_id ON messages(provider, provider_message_id) WHERE provider_message_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX idx_report_items_recording   ON generated_report_items(recording_id);--> statement-breakpoint
CREATE INDEX idx_report_items_composition ON generated_report_items(composition_id);
