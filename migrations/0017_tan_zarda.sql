CREATE TABLE `fixture_result_claims` (
	`id` text PRIMARY KEY NOT NULL,
	`fixture_id` text NOT NULL,
	`player_id` text NOT NULL,
	`outcome` text NOT NULL,
	`score_a` integer,
	`score_b` integer,
	`filed_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`fixture_id`) REFERENCES `fixtures`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`player_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `fixture_result_claims_fixture_player_unique` ON `fixture_result_claims` (`fixture_id`,`player_id`);--> statement-breakpoint
CREATE TABLE `fixture_results` (
	`fixture_id` text PRIMARY KEY NOT NULL,
	`outcome` text NOT NULL,
	`score_a` integer,
	`score_b` integer,
	`outcome_backers` integer NOT NULL,
	`margin_backers` integer NOT NULL,
	`voter_count` integer NOT NULL,
	`eligible_count` integer NOT NULL,
	`distinct_outcomes` integer NOT NULL,
	`distinct_scores` integer NOT NULL,
	`rostered` integer NOT NULL,
	`teams_accurate` integer NOT NULL,
	`locked_at` integer NOT NULL,
	`materialised_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`fixture_id`) REFERENCES `fixtures`(`id`) ON UPDATE no action ON DELETE no action
);
