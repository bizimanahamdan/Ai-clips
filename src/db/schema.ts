import {
  index,
  integer,
  jsonb,
  pgTable,
  real,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/**
 * Jobs are the single source of truth for the pipeline.
 * Everything is persisted so that:
 *  - the browser can poll progress across server restarts
 *  - interrupted jobs can be detected and reported honestly
 *  - failures keep enough context to be debugged later
 */
export const jobs = pgTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    status: text("status").notNull().default("queued"), // queued | processing | completed | failed | partial
    stage: text("stage").notNull().default("queued"),
    stageDetail: text("stage_detail"),
    progress: integer("progress").notNull().default(0),

    sourceType: text("source_type").notNull(), // upload | url
    sourceName: text("source_name").notNull(),
    sourceUrl: text("source_url"),
    /** Local path exists only while a worker is actively processing. */
    filePath: text("file_path"),
    /** Durable source location in Cloudflare R2. */
    sourceObjectKey: text("source_object_key"),
    fileSizeBytes: integer("file_size_bytes"),

    durationSec: real("duration_sec"),
    width: integer("width"),
    height: integer("height"),
    hasAudio: integer("has_audio"),

    language: text("language"),
    transcript: jsonb("transcript"),
    transcriptText: text("transcript_text"),

    requestedClips: integer("requested_clips").notNull().default(3),
    maxClipSec: integer("max_clip_sec").notNull().default(45),
    subtitlesEnabled: integer("subtitles_enabled").notNull().default(1),

    analysisProvider: text("analysis_provider"),
    analysisModel: text("analysis_model"),

    error: jsonb("error").$type<{
      message: string;
      stage: string;
      detail?: string;
      kind?: string;
    }>(),

    workDir: text("work_dir"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (table) => [
    index("jobs_created_at_idx").on(table.createdAt),
    index("jobs_status_idx").on(table.status),
  ],
);

export const clips = pgTable(
  "clips",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    clipIndex: integer("clip_index").notNull(),
    status: text("status").notNull().default("pending"), // pending | rendering | ready | failed
    title: text("title").notNull(),
    hook: text("hook"),
    reason: text("reason"),
    score: integer("score"),
    startSec: real("start_sec").notNull(),
    endSec: real("end_sec").notNull(),
    durationSec: real("duration_sec"),
    /** filePath is retained for backward-compatible migration only. */
    filePath: text("file_path"),
    objectKey: text("object_key"),
    posterObjectKey: text("poster_object_key"),
    fileName: text("file_name"),
    fileSizeBytes: integer("file_size_bytes"),
    width: integer("width"),
    height: integer("height"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("clips_job_id_idx").on(table.jobId)],
);

/**
 * Human readable debug trail. Rendered in the UI so nothing fails silently.
 */
export const jobEvents = pgTable(
  "job_events",
  {
    id: serial("id").primaryKey(),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    level: text("level").notNull().default("info"), // info | warn | error
    stage: text("stage").notNull(),
    message: text("message").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("job_events_job_id_idx").on(table.jobId)],
);

export type JobRow = typeof jobs.$inferSelect;
export type ClipRow = typeof clips.$inferSelect;
export type JobEventRow = typeof jobEvents.$inferSelect;
