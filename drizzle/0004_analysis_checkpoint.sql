-- Persist resumable transcript chunks, per-chunk provider results, and final selection.
-- Existing jobs remain valid and lazily create this checkpoint on their next analysis run.
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "analysis_checkpoint" jsonb;
