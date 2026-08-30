export type ErrorKind =
  | "missing_api_key"
  | "unsupported_media"
  | "too_large"
  | "download_failed"
  | "transcription_failed"
  | "invalid_ai_output"
  | "ffmpeg_error"
  | "rate_limited"
  | "disk_full"
  | "interrupted"
  | "no_clips"
  | "bad_request"
  | "not_found"
  | "internal";

export class AppError extends Error {
  kind: ErrorKind;
  detail?: string;
  status: number;
  retryable: boolean;
  /** Original upstream HTTP status, retained server-side for retry policy. */
  providerStatus?: number;
  retryAfterMs?: number;

  constructor(
    kind: ErrorKind,
    message: string,
    options: { detail?: string; status?: number; retryable?: boolean; providerStatus?: number; retryAfterMs?: number } = {},
  ) {
    super(message);
    this.name = "AppError";
    this.kind = kind;
    this.detail = options.detail;
    this.status = options.status ?? 500;
    this.retryable = options.retryable ?? false;
    this.providerStatus = options.providerStatus;
    this.retryAfterMs = options.retryAfterMs;
  }
}

/** Map provider HTTP failures onto friendly, actionable messages. */
export function describeHttpStatus(status: number, provider: string, body: string, retryAfterMs?: number): AppError {
  const snippet = body.slice(0, 400);
  if (status === 401 || status === 403) {
    return new AppError("missing_api_key", `${provider} rejected the API key (HTTP ${status}).`, {
      detail: snippet,
      status: 502,
      providerStatus: status,
    });
  }
  if (status === 402) {
    return new AppError("internal", `${provider} has insufficient credits (HTTP 402); using the next provider.`, {
      detail: snippet,
      status: 502,
      providerStatus: status,
    });
  }
  if (status === 429) {
    return new AppError(
      "rate_limited",
      `${provider} rate limit hit (HTTP 429). The job will retry or use a configured fallback automatically.`,
      { detail: snippet, status: 429, retryable: true, providerStatus: status, retryAfterMs },
    );
  }
  if (status === 413) {
    return new AppError("too_large", `${provider} rejected the request size (HTTP 413).`, {
      detail: snippet,
      status: 413,
      providerStatus: status,
    });
  }
  if (status === 404) {
    return new AppError(
      "invalid_ai_output",
      `${provider} does not know that model id (HTTP 404). Check the configured model environment variable.`,
      { detail: snippet, status: 502, providerStatus: status },
    );
  }
  if (status >= 500) {
    return new AppError("internal", `${provider} had a server error (HTTP ${status}).`, {
      detail: snippet,
      status: 502,
      retryable: true,
      providerStatus: status,
    });
  }
  return new AppError("internal", `${provider} request failed (HTTP ${status}).`, {
    detail: snippet,
    status: 502,
    providerStatus: status,
  });
}

export function toErrorPayload(error: unknown): {
  kind: string;
  message: string;
  detail?: string;
} {
  if (error instanceof AppError) {
    return { kind: error.kind, message: error.message, detail: error.detail };
  }
  if (error instanceof Error) {
    return { kind: "internal", message: error.message };
  }
  return { kind: "internal", message: String(error) };
}
