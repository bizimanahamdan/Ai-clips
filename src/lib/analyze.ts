import { z } from "zod";
import { config, providersConfigured, type AnalysisProvider } from "./config";
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
  phase?: "discovery" | "selection";
  chunk?: number;
};

export type AnalysisProgress = {
  phase: "preparing" | "discovery" | "selection";
  completed: number;
  total: number;
  message: string;
};

export type AnalysisResult = {
  clips: ClipCandidate[];
  provider: AnalysisProvider;
  model: string;
  raw: string;
  attempts: AnalysisAttempt[];
  chunkCount: number;
  discoveredCandidates: number;
};

export type TranscriptAnalysisChunk = {
  index: number;
  startSegment: number;
  endSegment: number;
  startSec: number;
  endSec: number;
  characterCount: number;
  estimatedTokens: number;
  block: string;
};

/** Conservative, dependency-free estimate suitable for request budgeting. */
export function estimateTokens(value: string): number {
  const clean = value.trim();
  if (!clean) return 0;
  const nonAsciiCharacters = (clean.match(/[^\x00-\x7F]/g) ?? []).length;
  const asciiCharacters = clean.length - nonAsciiCharacters;
  // Non-Latin scripts can approach one token per character; English prose is
  // deliberately estimated more conservatively than the usual ~4 chars/token.
  const characterEstimate = Math.ceil(asciiCharacters / 3 + nonAsciiCharacters);
  const wordEstimate = Math.ceil(clean.split(/\s+/).length * 1.35);
  return Math.max(characterEstimate, wordEstimate);
}

function truncateToTokenBudget(value: string, tokenBudget: number, characterBudget: number): string {
  let low = 0;
  let high = Math.min(value.length, characterBudget);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (estimateTokens(value.slice(0, middle)) <= tokenBudget) low = middle;
    else high = middle - 1;
  }
  return value.slice(0, low).trimEnd();
}

function formatClock(seconds: number): string {
  const safe = Math.max(0, seconds);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = (safe % 60).toFixed(1).padStart(4, "0");
  return hours > 0
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${secs}`
    : `${String(minutes).padStart(2, "0")}:${secs}`;
}

function segmentLine(transcript: Transcript, index: number): string {
  const segment = transcript.segments[index];
  return `[S${String(index).padStart(4, "0")} ${formatClock(segment.start)}-${formatClock(segment.end)}] ${segment.text.replace(/\s+/g, " ").trim()}`;
}

/** Compact indexed transcript retained for backward-compatible tests/tools. */
export function buildTranscriptPrompt(transcript: Transcript, maxChars = config.analysisTranscriptMaxChars): string {
  if (!transcript.segments.length) return transcript.text.slice(0, maxChars);
  const lines: string[] = [];
  let characters = 0;
  for (let index = 0; index < transcript.segments.length; index += 1) {
    const line = segmentLine(transcript, index);
    if (lines.length && characters + line.length + 1 > maxChars) break;
    lines.push(line);
    characters += line.length + 1;
  }
  return lines.join("\n");
}

/**
 * Split only at timestamped segment boundaries. Adjacent chunks overlap by a
 * small time window so a complete story crossing a boundary remains visible.
 */
export function splitTranscriptForAnalysis(
  transcript: Transcript,
  maxChars = config.analysisTranscriptMaxChars,
  overlapSec = config.analysisChunkOverlapSec,
  maxChunkSec = config.analysisChunkMaxSec,
  maxInputTokens = config.analysisMaxInputTokens,
  promptReserveTokens = config.analysisPromptReserveTokens,
): TranscriptAnalysisChunk[] {
  const safeInputBudget = Math.max(2_000, Math.min(6_000, Math.floor(maxInputTokens)));
  const safePromptReserve = Math.max(500, Math.min(safeInputBudget - 500, Math.floor(promptReserveTokens)));
  const transcriptTokenBudget = safeInputBudget - safePromptReserve;
  // Secondary hard cap protects deployments carrying old 18k/90k settings.
  const safeMaxChars = Math.max(4_000, Math.min(12_000, Math.round(maxChars)));
  if (!transcript.segments.length) {
    const source = transcript.text.trim();
    const block = truncateToTokenBudget(source, transcriptTokenBudget, safeMaxChars);
    return block ? [{
      index: 0,
      startSegment: 0,
      endSegment: 0,
      startSec: 0,
      endSec: transcript.durationSec,
      characterCount: block.length,
      estimatedTokens: estimateTokens(block),
      block,
    }] : [];
  }
  const chunks: TranscriptAnalysisChunk[] = [];
  let start = 0;
  while (start < transcript.segments.length) {
    const lines: string[] = [];
    let characters = 0;
    let estimatedWords = 0;
    let nonAsciiCharacters = 0;
    let end = start;
    while (end < transcript.segments.length) {
      const line = segmentLine(transcript, end);
      const nextCharacters = characters + line.length + (lines.length ? 1 : 0);
      const nextWords = estimatedWords + line.trim().split(/\s+/).length;
      const nextNonAscii = nonAsciiCharacters + (line.match(/[^\x00-\x7F]/g) ?? []).length;
      const nextAscii = nextCharacters - nextNonAscii;
      const nextTokens = Math.max(Math.ceil(nextAscii / 3 + nextNonAscii), Math.ceil(nextWords * 1.35));
      const exceedsTimeWindow = lines.length > 0 && transcript.segments[end].end - transcript.segments[start].start > maxChunkSec;
      if (lines.length && (nextCharacters > safeMaxChars || nextTokens > transcriptTokenBudget || exceedsTimeWindow)) break;
      lines.push(line);
      characters = nextCharacters;
      estimatedWords = nextWords;
      nonAsciiCharacters = nextNonAscii;
      end += 1;
    }
    // Always make progress if Whisper supplied one unusually large segment.
    if (end === start) {
      lines.push(truncateToTokenBudget(segmentLine(transcript, start), transcriptTokenBudget, safeMaxChars));
      characters = lines[0].length;
      end = start + 1;
    }
    const first = transcript.segments[start];
    const last = transcript.segments[end - 1];
    const block = lines.join("\n");
    chunks.push({
      index: chunks.length,
      startSegment: start,
      endSegment: end - 1,
      startSec: first.start,
      endSec: last.end,
      characterCount: block.length,
      estimatedTokens: estimateTokens(block),
      block,
    });
    if (end >= transcript.segments.length) break;
    const overlapStartTime = Math.max(first.start, last.end - Math.max(0, overlapSec));
    let nextStart = end;
    for (let index = end - 1; index > start; index -= 1) {
      if (transcript.segments[index].start < overlapStartTime) break;
      nextStart = index;
    }
    start = Math.max(start + 1, nextStart);
  }
  return chunks;
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
  chunkLabel?: string;
  preferredVibes?: string[];
}): string {
  const preferredMin = preferredClipMin(options.maxSec, options.minSec);
  const candidateCount = options.candidateCount ?? options.clipCount;
  const selectionContract = options.useSegmentIndexes === false
    ? "Return startSec and endSec as numeric seconds shown by the transcript."
    : "Return startSegment and endSegment as the integer S indexes shown below (inclusive). Never invent or recalculate timestamps.";
  return [
    "Act as a senior viral short-form editor. Find complete standalone moments, not isolated keywords.",
    options.chunkLabel ? `Transcript section: ${options.chunkLabel}. Search the entire section, not only its beginning.` : "",
    `Full video duration: ${formatClock(options.durationSec)}. Return ${candidateCount} distinct candidates.`,
    `Preferred duration ${preferredMin}-${options.maxSec}s; ${options.minSec}s is only a fallback floor.`,
    selectionContract,
    "Judge hook strength, emotion or useful information, story completeness, payoff, standalone context, and social retention.",
    "Do not start mid-thought, end before the payoff, or choose multiple versions of the same moment.",
    options.preferredVibes?.length
      ? `Weak tie-breaker only: when quality is equal, prefer content compatible with these optional music tags: ${options.preferredVibes.join(", ")}. Never sacrifice clip quality for music.`
      : "",
    "Return ONLY valid JSON: no markdown, code fences, commentary, or explanations outside JSON.",
    "Timestamp values, when requested, must be numeric seconds. S indexes are mapped server-side to exact numeric transcript timestamps.",
    "title must be concise (max 80 chars); hook max 60 chars; reason max 240 chars.",
    options.useSegmentIndexes === false
      ? '{"clips":[{"startSec":12.5,"endSec":48.2,"title":"Concise title","hook":"Short hook","reason":"Brief concrete rationale","score":87}]}'
      : '{"clips":[{"startSegment":42,"endSegment":58,"title":"Concise title","hook":"Short hook","reason":"Brief concrete rationale","score":92}]}',
    options.correction ? `CORRECTION: ${options.correction}` : "",
    "TRANSCRIPT",
    options.transcriptBlock,
  ].filter(Boolean).join("\n");
}

const SYSTEM_PROMPT = "You are an expert short-form story editor. Return strict JSON only. Select real transcript boundaries and complete narrative moments.";

const clipJsonSchema = (useSegments: boolean) => ({
  type: "object",
  additionalProperties: false,
  required: ["clips"],
  properties: {
    clips: {
      type: "array",
      minItems: 1,
      maxItems: 12,
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

const selectionJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["selections"],
  properties: {
    selections: {
      type: "array",
      minItems: 1,
      maxItems: 30,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["candidateId", "score"],
        properties: {
          candidateId: { type: "integer", minimum: 0 },
          score: { type: "integer", minimum: 1, maximum: 100 },
        },
      },
    },
  },
};

type ResponseMode = "json_schema" | "json_object";

function providerModel(provider: AnalysisProvider): string {
  if (provider === "gemini") return config.geminiTextModel;
  return provider === "openrouter" ? config.openrouterTextModel : config.groqTextModel;
}

function retryAfterMilliseconds(response: Response): number | undefined {
  const value = response.headers.get("retry-after")?.trim();
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

async function callOpenAiCompatible(options: {
  provider: "groq" | "openrouter";
  system: string;
  user: string;
  mode: ResponseMode;
  schema: Record<string, unknown>;
  outputTokenLimit: number;
  signal: AbortSignal;
}): Promise<string> {
  const isGroq = options.provider === "groq";
  const baseUrl = isGroq ? config.groqBaseUrl : config.openrouterBaseUrl;
  const key = isGroq ? config.groqApiKey : config.openrouterApiKey;
  const body = {
    model: providerModel(options.provider),
    temperature: 0.2,
    max_tokens: options.outputTokenLimit,
    messages: [{ role: "system", content: options.system }, { role: "user", content: options.user }],
    response_format: options.mode === "json_schema"
      ? { type: "json_schema", json_schema: { name: "analysis_result", strict: true, schema: options.schema } }
      : { type: "json_object" },
  };
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
    signal: options.signal,
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
    throw describeHttpStatus(
      response.status,
      `${isGroq ? "Groq" : "OpenRouter"} analysis`,
      text,
      retryAfterMilliseconds(response),
    );
  }
  const parsed = await response.json() as { choices?: Array<{ message?: { content?: string | null } }> };
  const content = parsed.choices?.[0]?.message?.content;
  if (!content) throw new AppError("invalid_ai_output", `${isGroq ? "Groq" : "OpenRouter"} returned an empty response.`, { retryable: true });
  return content;
}

function toGeminiSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toGeminiSchema);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== "additionalProperties")
      .map(([key, item]) => [
        key,
        key === "type" && typeof item === "string" ? item.toUpperCase() : toGeminiSchema(item),
      ]),
  );
}

async function callGemini(options: {
  system: string;
  user: string;
  schema: Record<string, unknown>;
  outputTokenLimit: number;
  signal: AbortSignal;
}): Promise<string> {
  const endpoint = `${config.geminiBaseUrl}/models/${encodeURIComponent(config.geminiTextModel)}:generateContent`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": config.geminiApiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: options.system }] },
      contents: [{ role: "user", parts: [{ text: options.user }] }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: options.outputTokenLimit,
        responseMimeType: "application/json",
        responseSchema: toGeminiSchema(options.schema),
      },
    }),
    signal: options.signal,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw describeHttpStatus(response.status, "Gemini analysis", text, retryAfterMilliseconds(response));
  }
  const parsed = await response.json() as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    promptFeedback?: unknown;
  };
  const content = parsed.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("").trim();
  if (!content) {
    throw new AppError("invalid_ai_output", "Gemini returned an empty analysis response.", {
      detail: JSON.stringify(parsed.promptFeedback ?? parsed).slice(0, 500),
      retryable: true,
    });
  }
  return content;
}

async function callProvider(options: {
  provider: AnalysisProvider;
  system: string;
  user: string;
  mode: ResponseMode;
  schema: Record<string, unknown>;
  outputTokenLimit: number;
}): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.analysisTimeoutSec * 1000);
  try {
    return await (options.provider === "gemini"
      ? callGemini({ ...options, signal: controller.signal })
      : callOpenAiCompatible({ ...options, provider: options.provider, signal: controller.signal }));
  } catch (error) {
    if ((error as Error).name === "AbortError") {
      throw new AppError("invalid_ai_output", `${options.provider} analysis timed out.`, { retryable: true });
    }
    throw error;
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
    else if (char === "{") { if (depth === 0) start = index; depth += 1; }
    else if (char === "}" && depth > 0) { depth -= 1; if (depth === 0 && start >= 0) results.push(content.slice(start, index + 1)); }
  }
  return results;
}

function balancedArrays(content: string): string[] {
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
    else if (char === "[") { if (depth === 0) start = index; depth += 1; }
    else if (char === "]" && depth > 0) { depth -= 1; if (depth === 0 && start >= 0) results.push(content.slice(start, index + 1)); }
  }
  return results;
}

function closeTruncatedJson(content: string): string | null {
  const start = Math.min(...[content.indexOf("{"), content.indexOf("[")].filter((value) => value >= 0));
  if (!Number.isFinite(start)) return null;
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
  for (const candidate of balancedArrays(trimmed)) candidates.add(candidate);
  for (const candidate of balancedObjects(trimmed)) candidates.add(candidate);
  const repaired = closeTruncatedJson(trimmed);
  if (repaired) candidates.add(repaired);
  for (const candidate of candidates) {
    try { return JSON.parse(candidate); } catch { /* try next safe extraction */ }
  }
  throw new AppError("invalid_ai_output", "The AI response did not contain usable JSON.", {
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
}).superRefine((clip, context) => {
  const segmentFields = Number(clip.startSegment !== undefined) + Number(clip.endSegment !== undefined);
  const timeFields = Number(clip.startSec !== undefined) + Number(clip.endSec !== undefined);
  if (!((segmentFields === 2 && timeFields === 0) || (timeFields === 2 && segmentFields === 0))) {
    context.addIssue({ code: "custom", message: "clip needs one complete segment or timestamp range" });
  }
});
function trimText(value: unknown, max: number): unknown {
  if (typeof value !== "string") return value;
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length > max ? clean.slice(0, max).trimEnd() : clean;
}

function canonicalResponse(value: unknown): unknown {
  const root = Array.isArray(value) ? { clips: value } : value;
  if (!root || typeof root !== "object") return root;
  const record = root as Record<string, unknown>;
  const entries = record.clips ?? record.moments ?? record.candidates ?? record.data;
  if (!Array.isArray(entries)) return root;
  return {
    clips: entries.map((entry) => {
      if (!entry || typeof entry !== "object") return entry;
      const raw = entry as Record<string, unknown>;
      return {
        ...(raw.startSegment ?? raw.start_segment) !== undefined ? { startSegment: raw.startSegment ?? raw.start_segment } : {},
        ...(raw.endSegment ?? raw.end_segment) !== undefined ? { endSegment: raw.endSegment ?? raw.end_segment } : {},
        ...(raw.startSec ?? raw.start ?? raw.start_time) !== undefined ? { startSec: raw.startSec ?? raw.start ?? raw.start_time } : {},
        ...(raw.endSec ?? raw.end ?? raw.end_time) !== undefined ? { endSec: raw.endSec ?? raw.end ?? raw.end_time } : {},
        title: trimText(raw.title ?? raw.headline, 80),
        hook: trimText(raw.hook ?? raw.opening, 60),
        reason: trimText(raw.reason ?? raw.rationale ?? raw.description, 240),
        score: raw.score ?? raw.rating,
      };
    }),
  };
}

export function parseTimestamp(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  const pieces = trimmed.split(":");
  if (pieces.length < 2 || pieces.length > 3 || pieces.some((part) => !/^\d+(?:\.\d+)?$/.test(part))) return null;
  const numbers = pieces.map(Number);
  const seconds = pieces.length === 2 ? numbers[0] * 60 + numbers[1] : numbers[0] * 3600 + numbers[1] * 60 + numbers[2];
  return numbers.at(-1)! < 60 && (pieces.length === 2 || numbers[1] < 60) ? seconds : null;
}

export function normaliseClips(value: unknown, transcript: Transcript, durationSec: number): ClipCandidate[] {
  const container = z.object({ clips: z.array(z.unknown()).min(1).max(120) }).safeParse(canonicalResponse(value));
  if (!container.success) {
    throw new AppError("invalid_ai_output", "AI JSON did not contain a usable clips array.", {
      detail: z.prettifyError(container.error).slice(0, 800),
      retryable: true,
    });
  }
  const valid: ClipCandidate[] = [];
  const issues: string[] = [];
  container.data.clips.forEach((rawClip, index) => {
    const parsed = RawClipSchema.safeParse(rawClip);
    if (!parsed.success) {
      issues.push(`candidate ${index + 1}: schema mismatch`);
      return;
    }
    const clip = parsed.data;
    let startSec: number | null;
    let endSec: number | null;
    if (clip.startSegment !== undefined && clip.endSegment !== undefined) {
      const start = transcript.segments[clip.startSegment];
      const end = transcript.segments[clip.endSegment];
      if (!start || !end || clip.endSegment < clip.startSegment) {
        issues.push(`candidate ${index + 1}: invalid segment indexes`);
        return;
      }
      startSec = start.start;
      endSec = end.end;
    } else {
      startSec = parseTimestamp(clip.startSec);
      endSec = parseTimestamp(clip.endSec);
    }
    if (startSec === null || endSec === null || endSec <= startSec || startSec < 0 || endSec > durationSec) {
      issues.push(`candidate ${index + 1}: timestamps outside source duration`);
      return;
    }
    valid.push({
      startSec,
      endSec,
      startSegment: clip.startSegment,
      endSegment: clip.endSegment,
      title: clip.title,
      hook: clip.hook,
      reason: clip.reason,
      score: Math.round(clip.score),
    });
  });
  if (!valid.length) {
    throw new AppError("invalid_ai_output", "AI response contained no candidates with valid source timestamps.", {
      detail: issues.slice(0, 12).join("; "),
      retryable: true,
    });
  }
  return valid;
}

function configuredProviders(prompt: string, outputTokenLimit: number): AnalysisProvider[] {
  const inputTokens = estimateTokens(`${SYSTEM_PROMPT}\n${prompt}`);
  return providersConfigured().order.filter((provider) => {
    if (provider === "groq" && (
      prompt.length > config.analysisGroqSafeChars
      || inputTokens + outputTokenLimit > config.analysisGroqTotalTokens
    )) {
      console.info(
        `[analysis] provider=groq skipped input_estimated_tokens=${inputTokens} output_token_limit=${outputTokenLimit} safe_total=${config.analysisGroqTotalTokens}`,
      );
      return false;
    }
    return true;
  });
}

function reduceTranscriptPrompt(prompt: string, chunk = 0): string {
  const marker = "\nTRANSCRIPT\n";
  const markerIndex = prompt.indexOf(marker);
  if (markerIndex < 0) return prompt;
  const prefix = prompt.slice(0, markerIndex + marker.length);
  const lines = prompt.slice(markerIndex + marker.length).split("\n").filter(Boolean);
  if (lines.length < 2) return prompt;
  const keep = Math.max(1, Math.floor(lines.length * 0.25));
  // Alternate retained portions across chunks so an emergency Groq retry does
  // not always bias toward the beginning of the full video.
  const reduced = chunk % 2 === 0 ? lines.slice(0, keep) : lines.slice(-keep);
  return `${prefix}${reduced.join("\n")}`;
}

async function runWithFallback(options: {
  user: string;
  schema: Record<string, unknown>;
  parse: (content: string, requestPrompt: string) => unknown;
  phase: "discovery" | "selection";
  chunk?: number;
  attempts: AnalysisAttempt[];
  unavailableProviders: Set<AnalysisProvider>;
}): Promise<{ value: unknown; provider: AnalysisProvider; model: string; raw: string }> {
  const configuredOutputLimit = options.phase === "discovery"
    ? config.analysisDiscoveryOutputTokens
    : config.analysisSelectionOutputTokens;
  const outputTokenLimit = Math.max(256, Math.min(2_000, Math.round(configuredOutputLimit)));
  const providers = configuredProviders(options.user, outputTokenLimit)
    .filter((provider) => !options.unavailableProviders.has(provider));
  if (!providers.length) {
    throw new AppError(
      "invalid_ai_output",
      options.unavailableProviders.size
        ? "All suitable AI providers are unavailable for this job."
        : "No suitable AI analysis provider is configured for this request size.",
      { status: 503 },
    );
  }
  for (const provider of providers) {
    const model = providerModel(provider);
    const maxAttempts = Math.max(1, Math.min(2, Math.floor(config.analysisMaxRetries) + 1));
    let correction = "";
    let providerUser = options.user;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const user = correction ? `${providerUser}\nCORRECTION: ${correction}` : providerUser;
      const inputTokens = estimateTokens(`${SYSTEM_PROMPT}\n${user}`);
      console.info(
        `[analysis] provider=${provider} model=${model} chunk=${options.chunk !== undefined ? `${options.chunk + 1}` : "ranking"} input_estimated_tokens=${inputTokens} output_token_limit=${outputTokenLimit} retry=${attempt - 1}`,
      );
      try {
        const raw = await callProvider({
          provider,
          system: SYSTEM_PROMPT,
          user,
          mode: attempt === 1 ? "json_schema" : "json_object",
          schema: options.schema,
          outputTokenLimit,
        });
        const value = options.parse(raw, user);
        options.attempts.push({ provider, model, attempt, outcome: "succeeded", detail: "valid response", phase: options.phase, chunk: options.chunk });
        return { value, provider, model, raw };
      } catch (error) {
        const appError = error instanceof AppError ? error : new AppError("invalid_ai_output", (error as Error).message, { retryable: true });
        const detail = `${appError.message}${appError.detail ? ` — ${appError.detail.slice(0, 300)}` : ""}`;
        options.attempts.push({ provider, model, attempt, outcome: "failed", detail, phase: options.phase, chunk: options.chunk });
        console.warn(`[analysis] provider=${provider} model=${model} chunk=${options.chunk !== undefined ? options.chunk + 1 : "ranking"} retry=${attempt - 1} failed: ${detail}`);
        if ([401, 402, 403, 404].includes(appError.providerStatus ?? 0)) {
          options.unavailableProviders.add(provider);
          console.warn(`[analysis] provider=${provider} model=${model} unavailable for the remainder of this job; continuing with fallback providers`);
        }

        const groqOversizeRetry = provider === "groq" && appError.providerStatus === 413 && attempt === 1 && options.phase === "discovery";
        if (groqOversizeRetry) {
          providerUser = reduceTranscriptPrompt(options.user, options.chunk ?? 0);
          correction = "Return only valid JSON for the smaller transcript section below.";
          console.warn(`[analysis] provider=groq model=${model} chunk=${(options.chunk ?? 0) + 1} HTTP 413; retrying once with input_estimated_tokens=${estimateTokens(providerUser)}`);
        } else {
          correction = "Return ONLY complete valid JSON, with no markdown or explanation. Keep title <= 80 chars, hook <= 60 chars, reason <= 240 chars, and use only supplied IDs/boundaries.";
        }

        const transient = appError.retryable || appError.kind === "rate_limited";
        const retryAfterTooLong = appError.providerStatus === 429 && (appError.retryAfterMs ?? 0) > 60_000;
        if (retryAfterTooLong) {
          console.warn(`[analysis] provider=${provider} retry-after=${appError.retryAfterMs}ms is too long for an inline retry; continuing fallback`);
        }
        if ((!transient && !groqOversizeRetry) || retryAfterTooLong || attempt >= maxAttempts) break;
        const exponentialDelay = Math.min(30_000, 750 * (2 ** (attempt - 1)));
        const delay = appError.providerStatus === 429
          ? Math.max(exponentialDelay, appError.retryAfterMs ?? 0)
          : provider === "gemini" ? exponentialDelay : 0;
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  throw new AppError("invalid_ai_output", `Every configured provider failed during ${options.phase}.`, { retryable: false });
}

function deduplicateCandidates(candidates: ClipCandidate[]): ClipCandidate[] {
  const kept: ClipCandidate[] = [];
  for (const candidate of [...candidates].sort((a, b) => b.score - a.score)) {
    const duplicate = kept.some((other) => {
      const overlap = Math.max(0, Math.min(candidate.endSec, other.endSec) - Math.max(candidate.startSec, other.startSec));
      const shortest = Math.max(1, Math.min(candidate.endSec - candidate.startSec, other.endSec - other.startSec));
      return overlap / shortest >= 0.65;
    });
    if (!duplicate) kept.push(candidate);
  }
  return kept;
}

const SelectionSchema = z.object({
  selections: z.array(z.object({ candidateId: z.coerce.number().int().nonnegative(), score: z.coerce.number().min(1).max(100) })).min(1).max(40),
});

function selectionPrompt(candidates: ClipCandidate[], count: number, preferredVibes: string[]): string {
  const summaries = candidates.map((candidate, index) =>
    `[C${index}] ${formatClock(candidate.startSec)}-${formatClock(candidate.endSec)} | ${candidate.title} | Hook: ${candidate.hook} | Why: ${candidate.reason} | discoveryScore=${candidate.score}`,
  );
  return [
    "Rank the strongest discovered moments globally. Return candidate IDs only; never create timestamps.",
    `Select up to ${Math.min(candidates.length, Math.max(count * 3, count))} diverse candidates likely to survive overlap removal.`,
    "Prioritize strong hook, emotional impact or interesting information, complete story/idea, viral potential, and standalone context.",
    preferredVibes.length ? `Music tags are a weak tie-breaker only: ${preferredVibes.join(", ")}.` : "",
    'JSON only: {"selections":[{"candidateId":0,"score":92}]}',
    ...summaries,
  ].filter(Boolean).join("\n");
}

/** Chunked discovery plus global selection; no request contains the full long transcript. */
export async function analyseTranscript(options: {
  transcript: Transcript;
  durationSec: number;
  clipCount: number;
  maxClipSec: number;
  preferredProvider?: AnalysisProvider | null;
  preferredVibes?: string[];
  onProgress?: (progress: AnalysisProgress) => void | Promise<void>;
}): Promise<AnalysisResult> {
  void options.preferredProvider; // Provider order is centralized and deterministic.
  const selectedMaxSec = Math.min(config.maxClipSec, Math.max(config.minClipSec, options.maxClipSec), options.durationSec);
  const chunkOverlapSec = Math.max(config.analysisChunkOverlapSec, Math.min(90, selectedMaxSec));
  const chunks = splitTranscriptForAnalysis(options.transcript, config.analysisTranscriptMaxChars, chunkOverlapSec);
  if (!chunks.length) throw new AppError("invalid_ai_output", "Transcript is empty, so no clip analysis is possible.");
  const configured = providersConfigured();
  if (config.geminiApiKey && !config.geminiTextModel) {
    console.warn("[analysis] provider=gemini skipped: GEMINI_TEXT_MODEL is not configured");
  }
  console.info(`[analysis] provider_priority=${configured.order.map((provider) => `${provider}/${providerModel(provider)}`).join(" -> ") || "none"}`);
  if (!configured.order.length) {
    throw new AppError("missing_api_key", "No AI analysis provider is configured.", {
      status: 503,
      detail: "Set GEMINI_API_KEY, OPENROUTER_API_KEY, and/or GROQ_API_KEY.",
    });
  }
  const targetCandidates = Math.min(40, Math.max(options.clipCount * config.analysisCandidateMultiplier, options.clipCount));
  const perChunk = Math.min(6, Math.max(3, Math.ceil(targetCandidates / chunks.length) + 1));
  const preferredVibes = [...new Set((options.preferredVibes ?? []).map((tag) => tag.trim()).filter(Boolean))].slice(0, 12);
  const attempts: AnalysisAttempt[] = [];
  const unavailableProviders = new Set<AnalysisProvider>();
  const candidates: ClipCandidate[] = [];
  let lastProvider = configured.order[0];
  let lastModel = providerModel(lastProvider);
  let lastRaw = "";

  await options.onProgress?.({ phase: "preparing", completed: 0, total: chunks.length, message: `Preparing ${chunks.length} transcript part(s)…` });
  console.info(`[analysis] prepared ${chunks.length} transcript chunk(s), ${options.transcript.segments.length} segments`);
  for (const chunk of chunks) {
    await options.onProgress?.({ phase: "discovery", completed: chunk.index, total: chunks.length, message: `Analyzing part ${chunk.index + 1} of ${chunks.length}…` });
    console.info(`[analysis] chunk=${chunk.index + 1}/${chunks.length} segments=${chunk.startSegment}-${chunk.endSegment} transcript_estimated_tokens=${chunk.estimatedTokens} chars=${chunk.characterCount}`);
    const prompt = buildUserPrompt({
      transcriptBlock: chunk.block,
      durationSec: options.durationSec,
      clipCount: options.clipCount,
      candidateCount: perChunk,
      minSec: Math.min(config.minClipSec, selectedMaxSec),
      maxSec: selectedMaxSec,
      useSegmentIndexes: options.transcript.segments.length > 0,
      chunkLabel: `${chunk.index + 1}/${chunks.length}, ${formatClock(chunk.startSec)}-${formatClock(chunk.endSec)}`,
      preferredVibes,
    });
    try {
      const result = await runWithFallback({
        user: prompt,
        schema: clipJsonSchema(options.transcript.segments.length > 0),
        parse: (raw, requestPrompt) => {
          const parsed = normaliseClips(extractJson(raw), options.transcript, options.durationSec);
          const suppliedIndexes = [...requestPrompt.matchAll(/\[S(\d+)/g)].map((match) => Number(match[1]));
          const suppliedStart = suppliedIndexes.length ? Math.min(...suppliedIndexes) : chunk.startSegment;
          const suppliedEnd = suppliedIndexes.length ? Math.max(...suppliedIndexes) : chunk.endSegment;
          const suppliedStartSec = options.transcript.segments[suppliedStart]?.start ?? chunk.startSec;
          const suppliedEndSec = options.transcript.segments[suppliedEnd]?.end ?? chunk.endSec;
          const insideChunk = parsed.filter((candidate) => {
            if (candidate.startSegment !== undefined && candidate.endSegment !== undefined) {
              return candidate.startSegment >= suppliedStart && candidate.endSegment <= suppliedEnd;
            }
            return candidate.startSec >= suppliedStartSec && candidate.endSec <= suppliedEndSec;
          });
          if (!insideChunk.length) {
            throw new AppError("invalid_ai_output", "Provider selected boundaries outside the supplied transcript part.", { retryable: true });
          }
          return insideChunk;
        },
        phase: "discovery",
        chunk: chunk.index,
        attempts,
        unavailableProviders,
      });
      const found = result.value as ClipCandidate[];
      candidates.push(...found);
      lastProvider = result.provider;
      lastModel = result.model;
      lastRaw = result.raw;
      console.info(`[analysis] chunk ${chunk.index + 1}/${chunks.length}: ${result.provider}/${result.model} found ${found.length} candidate(s)`);
    } catch (error) {
      // One bad chunk must not discard candidates found elsewhere.
      console.warn(`[analysis] chunk ${chunk.index + 1}/${chunks.length} exhausted providers: ${(error as Error).message}`);
    }
    await options.onProgress?.({ phase: "discovery", completed: chunk.index + 1, total: chunks.length, message: `Analyzed part ${chunk.index + 1} of ${chunks.length}; ${candidates.length} candidates found` });
  }

  let ranked = deduplicateCandidates(candidates);
  if (!ranked.length) {
    throw new AppError("invalid_ai_output", "AI analysis could not find usable moments in the transcript.", {
      detail: `All configured providers were unavailable or returned unusable results for ${chunks.length} transcript part(s). Please retry shortly or check the configured AI providers.`,
    });
  }
  console.info(`[analysis] discovery found ${candidates.length} candidate(s), ${ranked.length} after overlap deduplication`);

  if (chunks.length > 1 && ranked.length > options.clipCount) {
    await options.onProgress?.({ phase: "selection", completed: 0, total: 1, message: `Ranking ${ranked.length} promising moments…` });
    const prompt = selectionPrompt(ranked, options.clipCount, preferredVibes);
    try {
      const result = await runWithFallback({
        user: prompt,
        schema: selectionJsonSchema,
        parse: (raw) => SelectionSchema.parse(extractJson(raw)),
        phase: "selection",
        attempts,
        unavailableProviders,
      });
      const selection = result.value as z.infer<typeof SelectionSchema>;
      const selectedIds = new Set<number>();
      const selected: ClipCandidate[] = [];
      for (const item of selection.selections) {
        if (item.candidateId >= ranked.length || selectedIds.has(item.candidateId)) continue;
        selectedIds.add(item.candidateId);
        const candidate = ranked[item.candidateId];
        selected.push({ ...candidate, score: Math.round(candidate.score * 0.7 + item.score * 0.3) });
      }
      ranked = [...selected, ...ranked.filter((_, index) => !selectedIds.has(index))];
      lastProvider = result.provider;
      lastModel = result.model;
      lastRaw = result.raw;
      console.info(`[analysis] global selection used ${result.provider}/${result.model} and ranked ${selected.length} candidate(s)`);
    } catch (error) {
      // Discovery scores remain a safe global ranking fallback.
      console.warn(`[analysis] global AI selection failed; using discovery ranking: ${(error as Error).message}`);
    }
  }

  await options.onProgress?.({ phase: "selection", completed: 1, total: 1, message: "Selecting final clips and removing overlaps…" });
  const final = validateClips({
    candidates: ranked,
    durationSec: options.durationSec,
    transcript: options.transcript,
    requestedClips: options.clipCount,
    maxClipSec: options.maxClipSec,
  }).map(({ index: _index, words: _words, ...clip }) => clip);
  console.info(`[analysis] final selection: ${final.length} clip(s) from ${chunks.length} chunk(s)`);
  return {
    clips: final,
    provider: lastProvider,
    model: lastModel,
    raw: lastRaw,
    attempts,
    chunkCount: chunks.length,
    discoveredCandidates: candidates.length,
  };
}
