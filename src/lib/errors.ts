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

  constructor(
    kind: ErrorKind,
    message: string,
    options: { detail?: string; status?: number; retryable?: boolean } = {},
  ) {
    super(message);
    this.name = "AppError";
    this.kind = kind;
    this.detail = options.detail;
    this.status = options.status ?? 500;
    this.retryable = options.retryable ?? false;
  }
}

/** Map provider HTTP failures onto friendly, actionable messages. */
export function describeHttpStatus(status: number, provider: string, body: string): AppError {
  const snippet = body.slice(0, 400);
  if (status === 401 || status === 403) {
    return new AppError("missing_api_key", `${provider} rejected the API key (HTTP ${status}).`, {
      detail: snippet,
      status: 502,
    });
  }
  if (status === 429) {
    return new AppError(
      "rate_limited",
      `${provider} rate limit hit (HTTP 429). The job will retry automatically.`,
      { detail: snippet, status: 429, retryable: true },
    );
  }
  if (status === 413) {
    return new AppError("too_large", `${provider} says the upload is too large (HTTP 413).`, {
      detail: snippet,
      status: 413,
    });
  }
  if (status === 404) {
    return new AppError(
      "invalid_ai_output",
      `${provider} does not know that model id (HTTP 404). Check the *_MODEL env var.`,
      { detail: snippet, status: 502 },
    );
  }
  if (status >= 500) {
    return new AppError("internal", `${provider} had a server error (HTTP ${status}).`, {
      detail: snippet,
      status: 502,
      retryable: true,
    });
  }
  return new AppError("internal", `${provider} request failed (HTTP ${status}).`, {
    detail: snippet,
    status: 502,
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
