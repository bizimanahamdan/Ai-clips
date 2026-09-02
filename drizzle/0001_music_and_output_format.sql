ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "output_format" text DEFAULT '9:16' NOT NULL;
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "music_object_key" text;
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "music_file_name" text;
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "music_analysis" jsonb;
