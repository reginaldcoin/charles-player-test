CREATE TABLE `crash_reports` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`received_at` integer NOT NULL,
	`ua_family` text NOT NULL,
	`died_at` integer NOT NULL,
	`payload` text NOT NULL
);
