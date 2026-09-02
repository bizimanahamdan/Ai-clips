CREATE TABLE IF NOT EXISTS "jobs" (
  "id" text PRIMARY KEY NOT NULL,
  "status" text DEFAULT 'queued' NOT NULL,
  "stage" text DEFAULT 'queued' NOT NULL,
  "stage_detail" text,
  "progress" integer DEFAULT 0 NOT NULL,
  "source_type" text NOT NULL,
  "source_name" text NOT NULL,
  "source_url" text,
  "file_path" text,
  "source_object_key" text,
  "file_size_bytes" integer,
  "duration_sec" real,
  "width" integer,
  "height" integer,
  "has_audio" integer,
  "language" text,
  "transcript" jsonb,
  "transcript_text" text,
  "requested_clips" integer DEFAULT 3 NOT NULL,
  "max_clip_sec" integer DEFAULT 45 NOT NULL,
  "subtitles_enabled" integer DEFAULT 1 NOT NULL,
  "analysis_provider" text,
  "analysis_model" text,
  "error" jsonb,
  "work_dir" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "started_at" timestamp with time zone,
  "finished_at" timestamp with time zone,
  "expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "clips" (
  "id" text PRIMARY KEY NOT NULL,
  "job_id" text NOT NULL,
  "clip_index" integer NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "title" text NOT NULL,
  "hook" text,
  "reason" text,
  "score" integer,
  "start_sec" real NOT NULL,
  "end_sec" real NOT NULL,
  "duration_sec" real,
  "file_path" text,
  "object_key" text,
  "poster_object_key" text,
  "file_name" text,
  "file_size_bytes" integer,
  "width" integer,
  "height" integer,
  "error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "clips_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "job_events" (
  "id" serial PRIMARY KEY NOT NULL,
  "job_id" text NOT NULL,
  "level" text DEFAULT 'info' NOT NULL,
  "stage" text NOT NULL,
  "message" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "job_events_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "source_object_key" text;
--> statement-breakpoint
ALTER TABLE "clips" ADD COLUMN IF NOT EXISTS "object_key" text;
--> statement-breakpoint
ALTER TABLE "clips" ADD COLUMN IF NOT EXISTS "poster_object_key" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jobs_created_at_idx" ON "jobs" USING btree ("created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jobs_status_idx" ON "jobs" USING btree ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "clips_job_id_idx" ON "clips" USING btree ("job_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_events_job_id_idx" ON "job_events" USING btree ("job_id");
