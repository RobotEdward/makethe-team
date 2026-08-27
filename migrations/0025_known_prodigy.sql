-- M39, BR-53. Once-per-(game, address, UTC day) guard for the N-14 join
-- confirmation email: a row is inserted before the send, so a primary-key
-- conflict is what stops a leaked invite link from mailing the same address
-- repeatedly in a day.
CREATE TABLE `join_confirmations` (
	`game_id` text NOT NULL,
	`email` text NOT NULL,
	`day` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`game_id`, `email`, `day`),
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE cascade
);
