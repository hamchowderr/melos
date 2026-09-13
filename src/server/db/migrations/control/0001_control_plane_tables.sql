CREATE TABLE `control_audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_user_id` text,
	`organization_id` text,
	`action` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`before_json` text,
	`after_json` text,
	`occurred_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_control_audit_org_time` ON `control_audit_log` (`organization_id`,occurred_at DESC);--> statement-breakpoint
CREATE TABLE `migration_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`batch_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`from_version` integer NOT NULL,
	`to_version` integer NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`started_at` text,
	`finished_at` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspace_registry`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "migration_runs_status_check" CHECK(status IN ('pending','running','succeeded','failed','skipped'))
);
--> statement-breakpoint
CREATE INDEX `idx_migration_runs_batch` ON `migration_runs` (`batch_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_migration_runs_workspace` ON `migration_runs` (`workspace_id`,started_at DESC);--> statement-breakpoint
CREATE TABLE `workspace_member_settings` (
	`organization_id` text NOT NULL,
	`user_id` text NOT NULL,
	`timezone` text DEFAULT 'UTC' NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`organization_id`, `user_id`),
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `workspace_registry` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`database_name` text NOT NULL,
	`database_url` text NOT NULL,
	`db_token_ciphertext` text,
	`schema_version` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'provisioning' NOT NULL,
	`status_detail` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "workspace_registry_status_check" CHECK(status IN ('provisioning','active','migrating','failed','suspended','deleting'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_registry_organization_id_unique` ON `workspace_registry` (`organization_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_registry_database_name_unique` ON `workspace_registry` (`database_name`);