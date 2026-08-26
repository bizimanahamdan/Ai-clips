import fsp from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { config } from "@/lib/config";
import { toErrorPayload } from "@/lib/errors";
import { extractPoster, probeVideo, renderVerticalClip, runFfmpegArgs } from "@/lib/ffmpeg";
import { buildAssSubtitles, buildCaptionGroups, subtitleOptionsFor } from "@/lib/subtitles";
import { fileSize, removePath, storageRoot } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

type Step = { step: string; ok: boolean; ms: number; detail?: string };

/**
 * Renders a real 4-second synthetic clip (test pattern + tone + burned-in
 * caption) to prove that on THIS host: FFmpeg runs, x264+aac encode, the 9:16
 * center crop works, libass finds a font, and the output can be probed.
 * No fake data: every value below comes from an actual FFmpeg run.
 */
export async function GET() {
  const started = Date.now();
  const dir = path.join(storageRoot(), "selftest");
  const steps: Step[] = [];

  async function runStep<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const at = Date.now();
    try {
      const value = await fn();
      steps.push({ step: name, ok: true, ms: Date.now() - at });
      return value;
    } catch (error) {
      steps.push({ step: name, ok: false, ms: Date.now() - at, detail: (error as Error).message });
      throw error;
    }
  }

  try {
    await fsp.mkdir(dir, { recursive: true });
    const source = path.join(dir, "source.mp4");
    const output = path.join(dir, "clip.mp4");
    const poster = path.join(dir, "poster.jpg");
    const assPath = path.join(dir, "captions.ass");

    await runStep("generate synthetic source", () =>
      runFfmpegArgs([
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc=size=1280x720:rate=25:duration=4",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=4",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-shortest",
        source,
      ]),
    );

    const sourceProbe = await runStep("probe source", async () => {
      const value = await probeVideo(source);
      return {
        size: `${value.width}x${value.height}`,
        durationSec: Number(value.durationSec.toFixed(2)),
        hasAudio: value.hasAudio,
      };
    });

    // Realistic word timings, shaped exactly like the Groq Whisper response.
    const words = "This is a caption render test from your server"
      .split(" ")
      .map((word, index) => ({ word, start: 0.4 + index * 0.45, end: 0.8 + index * 0.45 }));
    const subtitleOptions = subtitleOptionsFor(config.targetWidth, config.targetHeight);

    await runStep("build ASS subtitles", async () => {
      const ass = buildAssSubtitles(buildCaptionGroups(words), subtitleOptions);
      await fsp.writeFile(assPath, ass, "utf8");
      return { cues: ass.split("\n").filter((line) => line.startsWith("Dialogue:")).length };
    });

    await runStep("render 9:16 clip with burned captions", () =>
      renderVerticalClip({
        input: source,
        output,
        startSec: 0.5,
        endSec: 3.5,
        subtitlePath: assPath,
        subtitlesEnabled: true,
        targetWidth: config.targetWidth,
        targetHeight: config.targetHeight,
        targetFps: config.targetFps,
        crf: config.videoCrf,
        preset: config.videoPreset,
        audioBitrateK: config.audioBitrateK,
        hasAudio: true,
      }),
    );

    const outputProbe = await runStep("probe rendered clip", async () => {
      const value = await probeVideo(output);
      return {
        size: `${value.width}x${value.height}`,
        durationSec: Number(value.durationSec.toFixed(2)),
        fps: value.fps,
        codecs: `${value.videoCodec}/${value.audioCodec}`,
      };
    });

    const posterCreated = await runStep("extract poster frame", () =>
      extractPoster({ input: source, output: poster, atSec: 1, width: 270 }),
    );

    const bytes = await fileSize(output);

    return NextResponse.json({
      ok: true,
      elapsedMs: Date.now() - started,
      steps,
      output: { bytes, ...outputProbe, posterCreated, subtitleFontSize: subtitleOptions.fontSize },
      source: sourceProbe,
      note: "All values above come from a real FFmpeg run on this host.",
    });
  } catch (error) {
    const payload = toErrorPayload(error);
    return NextResponse.json(
      {
        ok: false,
        elapsedMs: Date.now() - started,
        steps,
        error: payload.message,
        detail: payload.detail,
      },
      { status: 500 },
    );
  } finally {
    await removePath(dir).catch(() => undefined);
  }
}
