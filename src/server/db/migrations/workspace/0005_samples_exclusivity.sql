-- Workspace schema version 5: samples and exclusivity (docs/CONTRACT.md §4.2 and §4.3, CAT-011, RGT-009,
-- owner decision 2026-10-30). The defaults keep existing rows unchanged: no samples, not exclusive.
ALTER TABLE recordings ADD COLUMN contains_samples INTEGER NOT NULL DEFAULT 0 CHECK (contains_samples IN (0,1));
--> statement-breakpoint
ALTER TABLE recordings ADD COLUMN samples_cleared INTEGER NOT NULL DEFAULT 0 CHECK (samples_cleared IN (0,1));
--> statement-breakpoint
ALTER TABLE agreements ADD COLUMN is_exclusive INTEGER NOT NULL DEFAULT 0 CHECK (is_exclusive IN (0,1));
--> statement-breakpoint
ALTER TABLE agreements ADD COLUMN exclusivity_scope TEXT;
