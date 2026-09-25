CREATE TABLE `fixture_potm_votes` (
	`id` text PRIMARY KEY NOT NULL,
	`fixture_id` text NOT NULL,
	`voter_id` text NOT NULL,
	`candidate_id` text NOT NULL,
	`voted_at` integer NOT NULL,
	FOREIGN KEY (`fixture_id`) REFERENCES `fixtures`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`voter_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`candidate_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `fixture_potm_votes_fixture_voter_unique` ON `fixture_potm_votes` (`fixture_id`,`voter_id`);