import { NextResponse } from "next/server";
import { config, providersConfigured } from "@/lib/config";
import { ensureRuntime, getJobStats, queueSnapshot } from "@/lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  await ensureRuntime();
  const providers = providersConfigured();
  const stats = await getJobStats();

  return NextResponse.json({
    providers: {
      transcription: providers.groq ? "groq" : null,
      analysis: providers.order,
      geminiConfigured: providers.gemini,
      groqConfigured: providers.groq,
      openrouterConfigured: providers.openrouter,
      geminiModel: providers.gemini ? config.geminiTextModel : null,
      groqModel: config.groqTextModel,
      transcribeModel: config.groqTranscribeModel,
      openrouterModel: providers.openrouter ? config.openrouterTextModel : null,
    },
    limits: {
      maxUploadMb: config.maxUploadMb,
      maxUrlSizeMb: config.maxUrlSizeMb,
      urlDownloadTimeoutSec: config.urlDownloadTimeoutSec,
      maxDurationMinutes: config.maxDurationMinutes,
      maxClipCount: config.maxClipCount,
      defaultClipCount: config.defaultClipCount,
      minClipSec: config.minClipSec,
      maxClipSec: config.maxClipSec,
      retentionHours: config.retentionHours,
      maxConcurrentJobs: config.maxConcurrentJobs,
    },
    output: {
      defaultFormat: "9:16",
      formats: {
        "9:16": { width: config.targetWidth, height: config.targetHeight },
        "1:1": { width: config.squareSize, height: config.squareSize },
        "16:9": { width: config.landscapeWidth, height: config.landscapeHeight },
      },
      fps: config.targetFps,
      crf: config.videoCrf,
    },
    queue: queueSnapshot(),
    stats,
    videoSources: ["upload", "direct_url"],
    platformLinksSupported: false,
  });
}
