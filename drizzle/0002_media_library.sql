CREATE TABLE IF NOT EXISTS "media_assets" (
  "id" text PRIMARY KEY NOT NULL,
  "category" text NOT NULL,
  "name" text NOT NULL,
  "file_name" text NOT NULL,
  "content_type" text NOT NULL,
  "object_key" text NOT NULL UNIQUE,
  "file_size_bytes" integer NOT NULL,
  "duration_sec" real NOT NULL,
  "tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "analysis" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "media_assets_category_idx" ON "media_assets" USING btree ("category");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "media_assets_created_at_idx" ON "media_assets" USING btree ("created_at");
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "media_mode" text DEFAULT 'none' NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "job_media_assets" (
  "job_id" text NOT NULL REFERENCES "jobs"("id") ON DELETE CASCADE,
  "asset_id" text NOT NULL REFERENCES "media_assets"("id") ON DELETE RESTRICT,
  "role" text NOT NULL,
  "sort_order" integer DEFAULT 0 NOT NULL,
  CONSTRAINT "job_media_assets_job_id_asset_id_pk" PRIMARY KEY("job_id", "asset_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_media_assets_job_idx" ON "job_media_assets" USING btree ("job_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_media_assets_asset_idx" ON "job_media_assets" USING btree ("asset_id");
