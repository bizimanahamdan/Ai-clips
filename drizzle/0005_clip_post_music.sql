-- Track non-destructive post-render music versions for existing clips.
ALTER TABLE "clips" ADD COLUMN IF NOT EXISTS "original_object_key" text;
ALTER TABLE "clips" ADD COLUMN IF NOT EXISTS "music_asset_id" text;
ALTER TABLE "clips" ADD COLUMN IF NOT EXISTS "music_object_key" text;
ALTER TABLE "clips" ADD COLUMN IF NOT EXISTS "music_volume" real;
ALTER TABLE "clips" ADD COLUMN IF NOT EXISTS "music_enabled" integer NOT NULL DEFAULT 0;
ALTER TABLE "clips" ADD COLUMN IF NOT EXISTS "music_status" text NOT NULL DEFAULT 'none';
ALTER TABLE "clips" ADD COLUMN IF NOT EXISTS "music_error" text;
