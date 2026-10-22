CREATE TABLE `contributions` (
	`id` text PRIMARY KEY NOT NULL,
	`place_id` text NOT NULL,
	`user_id` text NOT NULL,
	`display_name` text NOT NULL,
	`kind` text NOT NULL,
	`body` text NOT NULL,
	`photo_key` text,
	`visited_at` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `contributions_place_idx` ON `contributions` (`place_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `contributions_user_idx` ON `contributions` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `ratings` (
	`id` text PRIMARY KEY NOT NULL,
	`place_id` text NOT NULL,
	`user_id` text NOT NULL,
	`contribution_id` text NOT NULL,
	`value` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ratings_user_place_unique` ON `ratings` (`user_id`,`place_id`);