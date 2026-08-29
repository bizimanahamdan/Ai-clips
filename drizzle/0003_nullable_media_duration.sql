-- Media Library uploads are persisted without a blocking FFprobe/FFmpeg pass.
-- Existing duration values remain unchanged; new assets may be enriched later.
ALTER TABLE "media_assets" ALTER COLUMN "duration_sec" DROP NOT NULL;
