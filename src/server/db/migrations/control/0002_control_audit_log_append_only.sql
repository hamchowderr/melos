-- drizzle-kit does not model triggers. control_audit_log is append-only (docs/CONTRACT.md §4.1).
CREATE TRIGGER control_audit_log_no_update BEFORE UPDATE ON control_audit_log
BEGIN SELECT RAISE(ABORT, 'control_audit_log is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER control_audit_log_no_delete BEFORE DELETE ON control_audit_log
BEGIN SELECT RAISE(ABORT, 'control_audit_log is append-only'); END;
