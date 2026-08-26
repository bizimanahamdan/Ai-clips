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
      groqConfigured: providers.groq,
      openrouterConfigured: providers.openrouter,
      groqModel: config.groqTextModel,
      transcribeModel: config.groqTranscribeModel,
      openrouterModel: providers.openrouter ? config.openrouterTextModel : null,
    },
    limits: {
      maxUploadMb: config.maxUploadMb,
      maxDurationMinutes: config.maxDurationMinutes,
      maxClipCount: config.maxClipCount,
      defaultClipCount: config.defaultClipCount,
      minClipSec: config.minClipSec,
      maxClipSec: config.maxClipSec,
      retentionHours: config.retentionHours,
      maxConcurrentJobs: config.maxConcurrentJobs,
    },
    output: {
      width: config.targetWidth,
      height: config.targetHeight,
      fps: config.targetFps,
      crf: config.videoCrf,
    },
    queue: queueSnapshot(),
    stats,
    platformLinksSupported: false,
  });
}
