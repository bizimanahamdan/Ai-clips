import { z } from "zod";
import { config, type AnalysisProvider } from "./config";
import { AppError, describeHttpStatus } from "./errors";
import type { ClipCandidate, Transcript } from "./types";
import { preferredClipMin } from "./clip-duration";
import { validateClips } from "./validate";

export type AnalysisAttempt = {
  provider: AnalysisProvider;
  model: string;
  attempt: number;
  outcome: "failed" | "succeeded";
  detail: string;
};

export type AnalysisResult = {
  clips: ClipCandidate[];
  provider: AnalysisProvider;
  model: string;
  raw: string;
  attempts: AnalysisAttempt[];
};

function formatClock(seconds: number): string {
  const safe = Math.max(0, seconds);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = (safe % 60).toFixed(1).padStart(4, "0");
  return hours > 0
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${secs}`
    : `${String(minutes).padStart(2, "0")}:${secs}`;
}

/**
 * A compact, indexed transcript. The model selects these stable indexes and
 * the backend owns timestamp conversion. No video bytes are sent to the LLM.
 */
export function buildTranscriptPrompt(transcript: Transcript, maxChars = config.analysisTranscriptMaxChars): string {
  const lines: string[] = [];
  let characterCount = 0;
  for (let index = 0; index < transcript.segments.length; index += 1) {
    const segment = transcript.segments[index];
    const line = `[S${String(index).padStart(4, "0")} ${formatClock(segment.start)}-${formatClock(segment.end)}] ${segment.text}`;
    if (lines.length && characterCount + line.length + 1 > maxChars) {
      lines.push("…[transcript truncated at configured analysis limit]");
      break;
    }
    lines.push(line);
    characterCount += line.length + 1;
  }
  return lines.join("\n") || transcript.text.slice(0, maxChars);
}

export function buildUserPrompt(options: {
  transcriptBlock: string;
  durationSec: number;
  clipCount: number;
  candidateCount?: number;
  minSec: number;
  maxSec: number;
  useSegmentIndexes?: boolean;
  correction?: string;
}): string {
  const preferredMin = preferredClipMin(options.maxSec, options.minSec);
  const candidateCount = options.candidateCount ?? options.clipCount;
  const selectionContract = options.useSegmentIndexes === false
    ? "Return startSec and endSec as numeric seconds."
    : "Return startSegment and endSegment as the integer S indexes shown below (inclusive). Do not calculate timestamps.";
  return [
    "Act as a senior viral short-form video editor. Analyze narrative quality, not isolated dramatic keywords.",
    `Video duration: ${formatClock(options.durationSec)} (${options.durationSec.toFixed(1)}s).`,
    `Generate ${candidateCount} distinct candidates; the backend will rank and select the best ${options.clipCount}.`,
    `The user selected ${options.maxSec}s maximum. Preferred range: ${preferredMin}-${options.maxSec}s.`,
    `${options.minSec}s is only a fallback floor. Prefer a complete moment over an arbitrarily short clip.`,
    selectionContract,
    "",
    "For every candidate evaluate:",
    "- hook strength in the opening seconds",
    "- enough setup/context for a new viewer",
    "- development, conflict, discovery, or useful progression",
    "- emotional, funny, surprising, educational, dramatic, or curiosity value",
    "- a satisfying payoff/conclusion",
    "- standalone clarity and likely social-media retention",
    "",
    "Hard rules:",
    "- Select a complete mini-story or complete idea: setup → development → payoff.",
    "- Never start mid-conversation where pronouns or context are confusing.",
    "- Never end mid-sentence, before the answer, or before the important reaction/payoff.",
    "- Do not select a moment merely because it contains an exciting keyword.",
    "- Keep candidates topically diverse and non-overlapping whenever possible.",
    `- Strongly prefer ${preferredMin}-${options.maxSec}s. Use ${options.minSec}-${Math.max(options.minSec, preferredMin - 1)}s only if no coherent longer boundary exists.`,
    "- Score 1-100 using hook, arc, payoff, clarity, emotion/utility, and retention—not sensational wording alone.",
    "- title: concise social title (1-80 chars); hook: opening promise (1-60 chars); reason: concrete quality rationale (1-240 chars).",
    "- Return only the requested JSON object.",
    options.useSegmentIndexes === false
      ? '{"clips":[{"startSec":12.5,"endSec":48.2,"title":"...","hook":"...","reason":"...","score":87}]}'
      : '{"clips":[{"startSegment":42,"endSegment":58,"title":"...","hook":"...","reason":"...","score":92}]}',
    options.correction ? `\nCORRECTION FOR THIS RETRY: ${options.correction}` : "",
    "",
    "Indexed transcript:",
    "-------------------",
    options.transcriptBlock,
    "-------------------",
  ].filter(Boolean).join("\n");
}

const SYSTEM_PROMPT = [
  "You are an expert short-form story editor.",
  "Choose self-contained narrative moments with hooks, context, development, and payoff.",
  "Obey the response schema exactly and output JSON only.",
].join(" ");

const clipJsonSchema = (useSegments: boolean) => ({
  type: "object",
  additionalProperties: false,
  required: ["clips"],
  properties: {
    clips: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: useSegments
          ? ["startSegment", "endSegment", "title", "hook", "reason", "score"]
          : ["startSec", "endSec", "title", "hook", "reason", "score"],
        properties: {
          ...(useSegments
            ? { startSegment: { type: "integer", minimum: 0 }, endSegment: { type: "integer", minimum: 0 } }
            : { startSec: { type: "number", minimum: 0 }, endSec: { type: "number", minimum: 0 } }),
          title: { type: "string", minLength: 1, maxLength: 80 },
          hook: { type: "string", minLength: 1, maxLength: 60 },
          reason: { type: "string", minLength: 1, maxLength: 240 },
          score: { type: "integer", minimum: 1, maximum: 100 },
        },
      },
    },
  },
});

type ChatResponse = {
  choices?: Array<{ message?: { content?: string | null } }>;
};

type ResponseMode = "json_schema" | "json_object";

async function callChat(options: {
  provider: AnalysisProvider;
  system: string;
  user: string;
  mode: ResponseMode;
  useSegments: boolean;
}): Promise<string> {
  const isGroq = options.provider === "groq";
  const baseUrl = isGroq ? config.groqBaseUrl : config.openrouterBaseUrl;
  const key = isGroq ? config.groqApiKey : config.openrouterApiKey;
  const model = isGroq ? config.groqTextModel : config.openrouterTextModel;
  const body: Record<string, unknown> = {
    model,
    temperature: 0.2,
    max_tokens: 4096,
    messages: [
      { role: "system", content: options.system },
      { role: "user", content: options.user },
    ],
    response_format: options.mode === "json_schema"
      ? {
          type: "json_schema",
          json_schema: {
            name: "clip_candidates",
            strict: true,
            schema: clipJsonSchema(options.useSegments),
          },
        }
      : { type: "json_object" },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.analysisTimeoutSec * 1000);
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        ...(isGroq ? {} : {
          "HTTP-Referer": process.env.OPENROUTER_SITE_URL?.trim() || config.frontendUrl || "https://clipforge.local",
          "X-Title": process.env.OPENROUTER_SITE_NAME?.trim() || "ClipForge",
        }),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      if (response.status === 400 && options.mode === "json_schema") {
        throw new AppError("invalid_ai_output", `${isGroq ? "Groq" : "OpenRouter"} rejected strict structured output.`, {
          detail: text.slice(0, 400),
          status: 502,
          retryable: true,
        });
      }
      throw describeHttpStatus(response.status, `${isGroq ? "Groq" : "OpenRouter"} analysis`, text);
    }
    const parsed = (await response.json()) as ChatResponse;
    const content = parsed.choices?.[0]?.message?.content;
    if (!content) {
      throw new AppError("invalid_ai_output", "The analysis model returned an empty response.", {
        detail: JSON.stringify(parsed).slice(0, 400),
        retryable: true,
      });
    }
    return content;
  } catch (error) {
    if (error instanceof AppError) throw error;
    if ((error as Error).name === "AbortError") {
      throw new AppError("invalid_ai_output", `${isGroq ? "Groq" : "OpenRouter"} analysis timed out.`, {
        retryable: true,
      });
    }
    throw new AppError("invalid_ai_output", `Could not reach ${isGroq ? "Groq" : "OpenRouter"}: ${(error as Error).message}`, {
      retryable: true,
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Return balanced JSON objects found outside/inside prose and Markdown fences. */
function balancedObjects(content: string): string[] {
  const results: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) results.push(content.slice(start, index + 1));
    }
  }
  return results;
}

/** Conservative recovery for a response truncated after otherwise valid JSON. */
function closeTruncatedJson(content: string): string | null {
  const start = content.indexOf("{");
  if (start < 0) return null;
  let value = content.slice(start).trim().replace(/```[a-z]*$/i, "").trim();
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const char of value) {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === "{" || char === "[") stack.push(char);
    else if (char === "}" || char === "]") stack.pop();
  }
  if (inString) value += '"';
  value = value.replace(/,\s*$/, "");
  while (stack.length) value += stack.pop() === "{" ? "}" : "]";
  return value;
}

export function extractJson(content: string): unknown {
  const trimmed = content.trim();
  const candidates = new Set<string>([trimmed]);
  for (const match of trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) candidates.add(match[1].trim());
  for (const candidate of balancedObjects(trimmed)) candidates.add(candidate);
  const repaired = closeTruncatedJson(trimmed);
  if (repaired) candidates.add(repaired);
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next safely extracted candidate.
    }
  }
  throw new AppError("invalid_ai_output", "The AI response did not contain a complete JSON object.", {
    detail: trimmed.slice(0, 600),
    retryable: true,
  });
}

const TimestampSchema = z.union([z.number(), z.string()]);
const RawClipSchema = z.object({
  startSegment: z.coerce.number().int().nonnegative().optional(),
  endSegment: z.coerce.number().int().nonnegative().optional(),
  startSec: TimestampSchema.optional(),
  endSec: TimestampSchema.optional(),
  title: z.string().trim().min(1).max(80),
  hook: z.string().trim().min(1).max(60),
  reason: z.string().trim().min(1).max(240),
  score: z.coerce.number().min(1).max(100),
}).strict().superRefine((clip, context) => {
  const segmentFields = Number(clip.startSegment !== undefined) + Number(clip.endSegment !== undefined);
  const timeFields = Number(clip.startSec !== undefined) + Number(clip.endSec !== undefined);
  if (!((segmentFields === 2 && timeFields === 0) || (timeFields === 2 && segmentFields === 0))) {
    context.addIssue({ code: "custom", message: "clip needs exactly one complete segment range or timestamp range" });
  }
});
const RawResponseSchema = z.object({ clips: z.array(RawClipSchema).min(1).max(40) }).strict();

export function parseTimestamp(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  const pieces = trimmed.split(":");
  if (pieces.length < 2 || pieces.length > 3 || pieces.some((part) => !/^\d+(?:\.\d+)?$/.test(part))) return null;
  const numbers = pieces.map(Number);
  const seconds = pieces.length === 2
    ? numbers[0] * 60 + numbers[1]
    : numbers[0] * 3600 + numbers[1] * 60 + numbers[2];
  return numbers.at(-1)! < 60 && (pieces.length === 2 || numbers[1] < 60) ? seconds : null;
}

function canonicalResponse(value: unknown): unknown {
  if (Array.isArray(value)) return { clips: value };
  if (!value || typeof value !== "object") return value;
  const root = value as Record<string, unknown>;
  const clips = root.clips ?? root.moments ?? root.data;
  if (!Array.isArray(clips)) return value;
  const normalised = clips.map((entry) => {
    if (!entry || typeof entry !== "object") return entry;
    const clip = { ...(entry as Record<string, unknown>) };
    if (clip.startSec === undefined && clip.start !== undefined) clip.startSec = clip.start;
    if (clip.endSec === undefined && clip.end !== undefined) clip.endSec = clip.end;
    delete clip.start;
    delete clip.end;
    return clip;
  });
  // Preserve keys when the canonical `clips` field exists so strict schema
  // validation still rejects unexpected root properties.
  return Array.isArray(root.clips) ? { ...root, clips: normalised } : { clips: normalised };
}

function normaliseClips(value: unknown, transcript: Transcript): ClipCandidate[] {
  const parsed = RawResponseSchema.safeParse(canonicalResponse(value));
  if (!parsed.success) {
    throw new AppError("invalid_ai_output", "AI JSON did not match the required clip schema.", {
      detail: z.prettifyError(parsed.error).slice(0, 1000),
      retryable: true,
    });
  }
  return parsed.data.clips.map((clip, index) => {
    let startSec: number | null = null;
    let endSec: number | null = null;
    if (clip.startSegment !== undefined && clip.endSegment !== undefined) {
      const start = transcript.segments[clip.startSegment];
      const end = transcript.segments[clip.endSegment];
      if (!start || !end || clip.endSegment < clip.startSegment) {
        throw new AppError("invalid_ai_output", `Candidate ${index + 1} selected invalid transcript segment indexes.`, {
          detail: `startSegment=${clip.startSegment}, endSegment=${clip.endSegment}, available=0-${Math.max(0, transcript.segments.length - 1)}`,
          retryable: true,
        });
      }
      startSec = start.start;
      endSec = end.end;
    } else {
      startSec = parseTimestamp(clip.startSec);
      endSec = parseTimestamp(clip.endSec);
    }
    if (startSec === null || endSec === null || endSec <= startSec) {
      throw new AppError("invalid_ai_output", `Candidate ${index + 1} has an invalid time range.`, {
        detail: `start=${String(clip.startSec)}, end=${String(clip.endSec)}`,
        retryable: true,
      });
    }
    return {
      startSec,
      endSec,
      startSegment: clip.startSegment,
      endSegment: clip.endSegment,
      title: clip.title,
      hook: clip.hook,
      reason: clip.reason,
      score: Math.round(clip.score),
    };
  });
}

/** Primary → one corrected retry → fallback provider, with no hidden recursion. */
export async function analyseTranscript(options: {
  transcript: Transcript;
  durationSec: number;
  clipCount: number;
  maxClipSec: number;
  preferredProvider?: AnalysisProvider | null;
}): Promise<AnalysisResult> {
  const configured: AnalysisProvider[] = [];
  if (options.preferredProvider) configured.push(options.preferredProvider);
  for (const provider of config.analysisProviders) if (!configured.includes(provider)) configured.push(provider);
  const available = configured.filter((provider) =>
    provider === "groq" ? Boolean(config.groqApiKey) : Boolean(config.openrouterApiKey),
  );
  if (!available.length) {
    throw new AppError("missing_api_key", "No AI analysis provider is configured.", {
      status: 503,
      detail: "Set GROQ_API_KEY and/or OPENROUTER_API_KEY.",
    });
  }

  const transcriptBlock = buildTranscriptPrompt(options.transcript);
  if (!transcriptBlock.trim()) throw new AppError("invalid_ai_output", "Transcript is empty, so no clip analysis is possible.");
  const useSegments = options.transcript.segments.length > 0;
  const selectedMaxSec = Math.min(config.maxClipSec, Math.max(config.minClipSec, options.maxClipSec), options.durationSec);
  const candidateCount = Math.min(
    40,
    Math.max(options.clipCount, Math.round(options.clipCount * config.analysisCandidateMultiplier)),
  );
  const attempts: AnalysisAttempt[] = [];

  for (const provider of available) {
    const model = provider === "groq" ? config.groqTextModel : config.openrouterTextModel;
    const maxAttempts = Math.max(1, Math.min(2, config.analysisMaxRetries + 1));
    let correction = "";
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const user = buildUserPrompt({
          transcriptBlock,
          durationSec: options.durationSec,
          clipCount: options.clipCount,
          candidateCount,
          minSec: Math.min(config.minClipSec, selectedMaxSec),
          maxSec: selectedMaxSec,
          useSegmentIndexes: useSegments,
          correction,
        });
        const content = await callChat({
          provider,
          system: SYSTEM_PROMPT,
          user,
          mode: attempt === 1 ? "json_schema" : "json_object",
          useSegments,
        });
        const clips = normaliseClips(extractJson(content), options.transcript);
        // Ensure this provider produced at least one renderable candidate before
        // accepting it; final ranking is repeated in the pipeline with logs.
        try {
          validateClips({
            candidates: clips,
            durationSec: options.durationSec,
            transcript: options.transcript,
            requestedClips: options.clipCount,
            maxClipSec: options.maxClipSec,
          });
        } catch (error) {
          throw new AppError("invalid_ai_output", "Provider candidates did not survive clip validation.", {
            detail: error instanceof Error ? error.message : String(error),
            retryable: true,
          });
        }
        attempts.push({ provider, model, attempt, outcome: "succeeded", detail: `${clips.length} valid candidates` });
        return { clips, provider, model, raw: content, attempts };
      } catch (error) {
        const appError = error instanceof AppError
          ? error
          : new AppError("invalid_ai_output", (error as Error).message, { retryable: true });
        const detail = `${appError.message}${appError.detail ? ` — ${appError.detail.slice(0, 300)}` : ""}`;
        attempts.push({ provider, model, attempt, outcome: "failed", detail });
        correction = `The previous response failed validation: ${appError.message} Return complete JSON, valid segment indexes, all required fields, and ${candidateCount} distinct candidates.`;
        // Missing/inaccessible model, bad key and rate limits should fall back
        // immediately; retry only malformed output/transient failures.
        if (!appError.retryable || appError.kind === "rate_limited" || appError.kind === "missing_api_key") break;
        if (attempt >= maxAttempts) break;
      }
    }
  }

  throw new AppError("invalid_ai_output", "AI clip analysis failed on every configured provider.", {
    detail: attempts.map((item) => `${item.provider}/${item.model} attempt ${item.attempt}: ${item.detail}`).join("\n").slice(0, 3000),
  });
}
