ALTER TABLE contributions ADD COLUMN moderation_status TEXT NOT NULL DEFAULT 'published';
--> statement-breakpoint
ALTER TABLE contributions ADD COLUMN fingerprint TEXT;
--> statement-breakpoint
CREATE UNIQUE INDEX contribution_fingerprint ON contributions(user_id, fingerprint) WHERE fingerprint IS NOT NULL;
--> statement-breakpoint
CREATE INDEX contributions_public ON contributions(moderation_status,created_at);
--> statement-breakpoint
CREATE TABLE reports(id TEXT PRIMARY KEY, contribution_id TEXT NOT NULL, reporter_id TEXT NOT NULL, reason TEXT NOT NULL, details TEXT NOT NULL, created_at INTEGER NOT NULL, resolved_at INTEGER, UNIQUE(contribution_id,reporter_id));
--> statement-breakpoint
CREATE INDEX reports_pending ON reports(resolved_at,created_at);
--> statement-breakpoint
CREATE TABLE bans(user_id TEXT PRIMARY KEY, reason TEXT NOT NULL, created_at INTEGER NOT NULL);
--> statement-breakpoint
CREATE TABLE moderation_log(id TEXT PRIMARY KEY, contribution_id TEXT NOT NULL, action TEXT NOT NULL, note TEXT NOT NULL, created_at INTEGER NOT NULL);
--> statement-breakpoint
CREATE TABLE security_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
--> statement-breakpoint
CREATE TABLE request_limits(key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL);
--> statement-breakpoint
CREATE INDEX limits_expiry ON request_limits(expires_at);
--> statement-breakpoint
CREATE TABLE admin_sessions(token_hash TEXT PRIMARY KEY, password_hash TEXT NOT NULL, expires_at INTEGER NOT NULL);
