ALTER TABLE `site_updates` ADD COLUMN `source_ref` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `site_updates_source_ref_unique` ON `site_updates` (`source_ref`);
