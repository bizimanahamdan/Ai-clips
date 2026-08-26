import { config, type AnalysisProvider } from "./config";
import { AppError, describeHttpStatus } from "./errors";
import type { ClipCandidate, Transcript } from "./types";

export type AnalysisResult = {
  clips: ClipCandidate[];
  provider: AnalysisProvider;
  model: string;
  raw: string;
};

function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** Compact transcript with timestamps, sized to stay inside a normal context window. */
export function buildTranscriptPrompt(transcript: Transcript, maxChars = 90_000): string {
  const lines: string[] = [];
  for (const segment of transcript.segments) {
    lines.push(`[${formatClock(segment.start)}] ${segment.text}`);
  }
  let joined = lines.join("\n");
  if (joined.length > maxChars) {
    joined = `${joined.slice(0, maxChars)}\n…[transcript truncated]`;
  }
  return joined || transcript.text.slice(0, maxChars);
}

export function buildUserPrompt(options: {
  transcriptBlock: string;
  durationSec: number;
  clipCount: number;
  minSec: number;
  maxSec: number;
}): string {
  return [
    `Video duration: ${formatClock(options.durationSec)} (${options.durationSec.toFixed(1)}s).`,
    `Wanted: the ${options.clipCount} strongest short-form moments.`,
    `Each clip must be between ${options.minSec} and ${options.maxSec} seconds.`,
    "",
    "Transcript with timestamps:",
    "---------------------------",
    options.transcriptBlock,
    "---------------------------",
    "",
    "Rules:",
    "- Pick self-contained moments that make sense without the rest of the video.",
    "- Prefer strong opinions, surprises, numbers, stories, contrarian takes, emotional peaks.",
    "- startSec and endSec must be inside the video duration and endSec > startSec.",
    "- Snap startSec to where the sentence actually begins, not mid-sentence.",
    "- hook must be a scroll-stopping on-screen line, max 60 characters.",
    "- title must be a short social post title, max 80 characters.",
    "- reason must explain in one sentence why this moment performs.",
    "- score is 1-100 confidence in the moment's viral potential.",
    "- Return EXACTLY a JSON object, no markdown, shaped as:",
    '{"clips":[{"startSec":12.5,"endSec":48.2,"title":"...","hook":"...","reason":"...","score":87}]}',
  ].join("\n");
}

const SYSTEM_PROMPT = [
  "You are a short-form video editor who finds the most engaging moments in long videos.",
  "You only reply with strict JSON. Never wrap JSON in markdown fences or commentary.",
  "Every clip must be self-contained and safe to post on TikTok, Reels and YouTube Shorts.",
].join(" ");

type ChatResponse = {
  choices?: Array<{ message?: { content?: string | null } }>;
  error?: { message?: string };
};

async function callChat(options: {
  provider: AnalysisProvider;
  system: string;
  user: string;
  jsonMode: boolean;
}): Promise<string> {
  const isGroq = options.provider === "groq";
  const baseUrl = isGroq ? config.groqBaseUrl : config.openrouterBaseUrl;
  const key = isGroq ? config.groqApiKey : config.openrouterApiKey;
  const model = isGroq ? config.groqTextModel : config.openrouterTextModel;

  const body: Record<string, unknown> = {
    model,
    temperature: 0.3,
    max_tokens: 4096,
    messages: [
      { role: "system", content: options.system },
      { role: "user", content: options.user },
    ],
  };
  if (options.jsonMode) body.response_format = { type: "json_object" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.analysisTimeoutSec * 1000);
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        ...(isGroq ? {} : {
          "HTTP-Referer": process.env.OPENROUTER_SITE_URL?.trim() || "https://clipforge.local",
          "X-Title": process.env.OPENROUTER_SITE_NAME?.trim() || "ClipForge",
        }),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const error = describeHttpStatus(response.status, isGroq ? "Groq" : "OpenRouter", text);
      // Some models reject response_format — retry once in plain mode.
      if (options.jsonMode && response.status === 400) {
        return await callChat({ ...options, jsonMode: false });
      }
      throw error;
    }

    const parsed = (await response.json()) as ChatResponse;
    const content = parsed.choices?.[0]?.message?.content;
    if (!content) {
      throw new AppError("invalid_ai_output", "The model returned an empty response.", {
        detail: JSON.stringify(parsed).slice(0, 400),
      });
    }
    return content;
  } catch (error) {
    if (error instanceof AppError) throw error;
    if ((error as Error).name === "AbortError") {
      throw new AppError(
        "invalid_ai_output",
        `${isGroq ? "Groq" : "OpenRouter"} analysis timed out after ${config.analysisTimeoutSec}s.`,
        { retryable: true },
      );
    }
    throw new AppError("invalid_ai_output", `Could not reach ${isGroq ? "Groq" : "OpenRouter"}: ${(error as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

export function extractJson(content: string): unknown {
  const trimmed = content.trim();
  const candidates: string[] = [trimmed];
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      /* try next */
    }
  }
  throw new AppError("invalid_ai_output", "The AI response was not valid JSON.", {
    detail: trimmed.slice(0, 600),
  });
}

type RawClip = {
  startSec?: unknown;
  endSec?: unknown;
  start?: unknown;
  end?: unknown;
  title?: unknown;
  hook?: unknown;
  reason?: unknown;
  score?: unknown;
};

function normaliseClips(value: unknown): ClipCandidate[] {
  const root = value as { clips?: unknown; moments?: unknown; data?: unknown };
  const list = Array.isArray(root?.clips)
    ? root.clips
    : Array.isArray(root?.moments)
      ? root.moments
      : Array.isArray(root?.data)
        ? root.data
        : Array.isArray(value)
          ? (value as unknown[])
          : [];

  return list.map((entry) => {
    const clip = entry as RawClip;
    const start = Number(clip.startSec ?? clip.start ?? 0);
    const end = Number(clip.endSec ?? clip.end ?? 0);
    return {
      startSec: start,
      endSec: end,
      title: typeof clip.title === "string" ? clip.title : "",
      hook: typeof clip.hook === "string" ? clip.hook : "",
      reason: typeof clip.reason === "string" ? clip.reason : "",
      score: Number(clip.score ?? 0),
    };
  });
}

/**
 * Ask the configured providers (Groq first, OpenRouter as fallback) for clip
 * candidates. Invalid JSON is retried on the next provider instead of failing.
 */
export async function analyseTranscript(options: {
  transcript: Transcript;
  durationSec: number;
  clipCount: number;
  preferredProvider?: AnalysisProvider | null;
}): Promise<AnalysisResult> {
  const configured: AnalysisProvider[] = [];
  if (options.preferredProvider) configured.push(options.preferredProvider);
  for (const provider of config.analysisProviders) {
    if (!configured.includes(provider)) configured.push(provider);
  }
  const available = configured.filter((p) =>
    p === "groq" ? Boolean(config.groqApiKey) : Boolean(config.openrouterApiKey),
  );
  if (!available.length) {
    throw new AppError(
      "missing_api_key",
      "No AI provider configured. Set GROQ_API_KEY (and optionally OPENROUTER_API_KEY).",
      { status: 503 },
    );
  }

  const transcriptBlock = buildTranscriptPrompt(options.transcript);
  if (!transcriptBlock.trim()) {
    throw new AppError("invalid_ai_output", "Transcript is empty, so no clip analysis is possible.");
  }

  const user = buildUserPrompt({
    transcriptBlock,
    durationSec: options.durationSec,
    clipCount: options.clipCount,
    minSec: config.minClipSec,
    maxSec: Math.min(config.maxClipSec, Math.max(config.minClipSec, options.durationSec)),
  });

  const errors: string[] = [];
  for (const provider of available) {
    for (let attempt = 0; attempt <= config.analysisMaxRetries; attempt += 1) {
      try {
        const content = await callChat({ provider, system: SYSTEM_PROMPT, user, jsonMode: true });
        const clips = normaliseClips(extractJson(content));
        if (!clips.length) {
          throw new AppError("invalid_ai_output", "The model returned zero clips.", {
            detail: content.slice(0, 400),
          });
        }
        return {
          clips,
          provider,
          model: provider === "groq" ? config.groqTextModel : config.openrouterTextModel,
          raw: content,
        };
      } catch (error) {
        const appError =
          error instanceof AppError
            ? error
            : new AppError("invalid_ai_output", (error as Error).message);
        errors.push(`${provider}#${attempt + 1}: ${appError.message}${appError.detail ? ` — ${appError.detail.slice(0, 200)}` : ""}`);
        if (appError.kind === "rate_limited") break; // move to the fallback provider
        if (attempt === config.analysisMaxRetries) break;
      }
    }
  }

  throw new AppError("invalid_ai_output", "AI clip analysis failed on every configured provider.", {
    detail: errors.join("\n").slice(0, 2000),
  });
}
