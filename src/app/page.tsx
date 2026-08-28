"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ClipCard, formatBytes } from "@/components/ClipCard";
import { JobProgress } from "@/components/JobProgress";
import type { ApiJob } from "@/lib/types";

type AppConfig = {
  providers: {
    transcription: string | null;
    analysis: string[];
    groqConfigured: boolean;
    openrouterConfigured: boolean;
    groqModel: string;
    transcribeModel: string;
    openrouterModel: string | null;
  };
  limits: {
    maxUploadMb: number;
    maxUrlSizeMb: number;
    urlDownloadTimeoutSec: number;
    maxDurationMinutes: number;
    maxClipCount: number;
    defaultClipCount: number;
    minClipSec: number;
    maxClipSec: number;
    retentionHours: number;
    maxConcurrentJobs: number;
  };
  output: { width: number; height: number; fps: number; crf: number };
  queue: { pending: number; running: number };
  stats: { total: number; active: number; clipsReady: number; storageMb: number };
};

type Mode = "upload" | "url";

export default function HomePage() {
  const [appConfig, setAppConfig] = useState<AppConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("upload");
  const [file, setFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState("");
  const [clipCount, setClipCount] = useState(3);
  const [maxClipSec, setMaxClipSec] = useState(45);
  const [subtitles, setSubtitles] = useState(true);

  const [uploadPercent, setUploadPercent] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<{ message: string; detail?: string } | null>(null);
  const [activeJob, setActiveJob] = useState<ApiJob | null>(null);
  const [history, setHistory] = useState<ApiJob[]>([]);
  const [selfTest, setSelfTest] = useState<string | null>(null);
  const [selfTestRunning, setSelfTestRunning] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const limits = appConfig?.limits;

  const loadConfig = useCallback(async () => {
    try {
      const response = await fetch("/api/config", { cache: "no-store" });
      if (!response.ok) throw new Error(`Config request failed (${response.status})`);
      setAppConfig((await response.json()) as AppConfig);
      setConfigError(null);
    } catch (err) {
      setConfigError((err as Error).message);
    }
  }, []);

  const loadHistory = useCallback(async () => {
    try {
      const response = await fetch("/api/jobs", { cache: "no-store" });
      if (!response.ok) return;
      const data = (await response.json()) as { jobs: ApiJob[] };
      setHistory(data.jobs);
      setActiveJob((current) => {
        if (current) return current;
        const firstInteresting = data.jobs.find(
          (job) => job.status === "processing" || job.status === "queued",
        );
        return firstInteresting ?? data.jobs[0] ?? null;
      });
    } catch {
      /* history is non-critical */
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadConfig();
      void loadHistory();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadConfig, loadHistory]);

  const poll = useCallback(async (jobId: string) => {
    try {
      const response = await fetch(`/api/jobs/${jobId}`, { cache: "no-store" });
      if (!response.ok) return;
      const data = (await response.json()) as { job: ApiJob };
      setActiveJob(data.job);
      if (data.job.status !== "processing" && data.job.status !== "queued") {
        if (pollRef.current) clearInterval(pollRef.current);
        pollRef.current = null;
        void loadHistory();
        void loadConfig();
      }
    } catch {
      /* keep polling; transient network errors are not fatal */
    }
  }, [loadConfig, loadHistory]);

  useEffect(() => {
    const jobId = activeJob?.id;
    const active = activeJob?.status === "processing" || activeJob?.status === "queued";
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
    if (jobId && active) {
      pollRef.current = setInterval(() => void poll(jobId), 2000);
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [activeJob?.id, activeJob?.status, poll]);

  const submitUpload = useCallback(() => {
    if (!file) {
      setError({ message: "Choose a video file first." });
      return;
    }
    if (limits && file.size > limits.maxUploadMb * 1024 * 1024) {
      setError({
        message: `That file is ${formatBytes(file.size)} — the server limit is ${limits.maxUploadMb}MB.`,
      });
      return;
    }

    setSubmitting(true);
    setError(null);
    setUploadPercent(0);

    const params = new URLSearchParams({
      filename: encodeURIComponent(file.name),
      clips: String(clipCount),
      maxClipSec: String(maxClipSec),
      subtitles: subtitles ? "1" : "0",
    });
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/jobs/upload?${params.toString()}`);
    xhr.setRequestHeader("x-file-name", encodeURIComponent(file.name));
    xhr.setRequestHeader("Content-Type", "application/octet-stream");

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        setUploadPercent(Math.round((event.loaded / event.total) * 100));
      }
    };
    xhr.onload = () => {
      setSubmitting(false);
      setUploadPercent(null);
      try {
        const data = JSON.parse(xhr.responseText) as { jobId?: string; error?: string; detail?: string };
        if (xhr.status >= 200 && xhr.status < 300 && data.jobId) {
          setFile(null);
          const input = document.getElementById("file-input") as HTMLInputElement | null;
          if (input) input.value = "";
          void loadHistory();
          setActiveJob({
            id: data.jobId,
            status: "queued",
            stage: "queued",
            stageLabel: "Queued",
            stageDetail: "Waiting for a worker slot",
            progress: 1,
            sourceType: "upload",
            sourceName: file.name,
            durationSec: null,
            width: null,
            height: null,
            fileSizeBytes: file.size,
            language: null,
            requestedClips: clipCount,
            maxClipSec,
            subtitlesEnabled: subtitles,
            analysisProvider: null,
            analysisModel: null,
            error: null,
            createdAt: new Date().toISOString(),
            finishedAt: null,
            expiresAt: null,
            clips: [],
            events: [],
            transcriptPreview: null,
          });
        } else {
          setError({ message: data.error || `Upload failed (${xhr.status})`, detail: data.detail });
        }
      } catch {
        setError({ message: `Upload failed (${xhr.status}): could not read the server response.` });
      }
    };
    xhr.onerror = () => {
      setSubmitting(false);
      setUploadPercent(null);
      setError({
        message: "Upload failed before reaching the server. Check your connection and try a smaller file.",
      });
    };
    xhr.send(file);
  }, [clipCount, file, limits, loadHistory, maxClipSec, subtitles]);

  const submitUrl = useCallback(async () => {
    setError(null);
    if (!videoUrl.trim()) {
      setError({ message: "Paste a direct video URL first." });
      return;
    }
    setSubmitting(true);
    try {
      const response = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: videoUrl.trim(),
          requestedClips: clipCount,
          maxClipSec,
          subtitlesEnabled: subtitles,
        }),
      });
      const data = (await response.json()) as { jobId?: string; error?: string; detail?: string };
      if (!response.ok || !data.jobId) {
        setError({ message: data.error || `Request failed (${response.status})`, detail: data.detail });
        return;
      }
      setVideoUrl("");
      void loadHistory();
      void poll(data.jobId);
    } catch (err) {
      setError({ message: (err as Error).message });
    } finally {
      setSubmitting(false);
    }
  }, [clipCount, loadHistory, maxClipSec, poll, subtitles, videoUrl]);

  const retry = useCallback(async (jobId: string) => {
    setError(null);
    try {
      const response = await fetch(`/api/jobs/${jobId}/retry`, { method: "POST" });
      const data = (await response.json()) as { error?: string; detail?: string };
      if (!response.ok) {
        setError({ message: data.error || "Retry failed", detail: data.detail });
        return;
      }
      void poll(jobId);
    } catch (err) {
      setError({ message: (err as Error).message });
    }
  }, [poll]);

  const remove = useCallback(
    async (jobId: string) => {
      await fetch(`/api/jobs/${jobId}`, { method: "DELETE" });
      setActiveJob((current) => (current?.id === jobId ? null : current));
      void loadHistory();
    },
    [loadHistory],
  );

  const providerReady = appConfig?.providers.analysis.length ?? 0;
  const busy = submitting || activeJob?.status === "processing" || activeJob?.status === "queued";

  const runSelfTest = useCallback(async () => {
    setSelfTestRunning(true);
    setSelfTest(null);
    try {
      const response = await fetch("/api/diagnostics/render", { cache: "no-store" });
      const data = (await response.json()) as unknown;
      setSelfTest(JSON.stringify(data, null, 2));
    } catch (err) {
      setSelfTest(`Self-test request failed: ${(err as Error).message}`);
    } finally {
      setSelfTestRunning(false);
    }
  }, []);

  return (
    <main className="space-y-5">
      <header className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold tracking-tight text-white">ClipForge</h1>
            <p className="text-xs text-slate-400">Long video → vertical clips with captions</p>
          </div>
          <div className="flex flex-col items-end gap-1">
            <span
              className={`rounded-full px-2 py-1 text-[10px] font-semibold ring-1 ${
                providerReady
                  ? "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30"
                  : "bg-red-500/15 text-red-300 ring-red-500/30"
              }`}
            >
              {providerReady ? `AI: ${appConfig?.providers.analysis.join(" → ")}` : "No AI key"}
            </span>
            {appConfig ? (
              <span className="text-[10px] text-slate-500">
                {appConfig.output.width}×{appConfig.output.height} · {appConfig.output.fps}fps
              </span>
            ) : null}
          </div>
        </div>
        {configError ? (
          <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-[11px] text-amber-300">
            Could not read server config: {configError}
          </p>
        ) : null}
      </header>

      {/* Source picker ---------------------------------------------------- */}
      <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
        <div className="mb-3 grid grid-cols-2 gap-1 rounded-xl bg-black/30 p-1">
          {(["upload", "url"] as Mode[]).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setMode(value)}
              className={`rounded-lg px-3 py-2 text-xs font-semibold transition ${
                mode === value ? "bg-indigo-500 text-white" : "text-slate-400"
              }`}
            >
              {value === "upload" ? "Upload Video" : "Paste Link"}
            </button>
          ))}
        </div>

        {mode === "upload" ? (
          <div>
            <label
              htmlFor="file-input"
              className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-white/15 bg-black/20 px-4 py-8 text-center"
            >
              <span className="text-2xl">🎬</span>
              <span className="text-xs font-medium text-slate-300">
                {file ? file.name : "Tap to choose a video"}
              </span>
              <span className="text-[11px] text-slate-500">
                {file
                  ? formatBytes(file.size)
                  : `MP4, MOV, MKV, WEBM · max ${limits?.maxUploadMb ?? "—"}MB · max ${limits?.maxDurationMinutes ?? "—"} min`}
              </span>
              <input
                id="file-input"
                type="file"
                accept="video/*"
                className="hidden"
                onChange={(event) => {
                  setError(null);
                  setFile(event.target.files?.[0] ?? null);
                }}
              />
            </label>
            <button
              type="button"
              onClick={submitUpload}
              disabled={!file || busy}
              className="mt-3 w-full rounded-xl bg-indigo-500 px-4 py-3.5 text-sm font-bold text-white transition active:scale-[0.99] active:bg-indigo-400 disabled:bg-white/5 disabled:text-slate-500"
            >
              {uploadPercent !== null ? `Uploading ${uploadPercent}%` : "Generate clips"}
            </button>
            {uploadPercent !== null ? (
              <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                <div className="h-full bg-indigo-400 transition-all" style={{ width: `${uploadPercent}%` }} />
              </div>
            ) : null}
          </div>
        ) : (
          <div className="space-y-3">
            <input
              type="url"
              inputMode="url"
              value={videoUrl}
              onChange={(event) => {
                setError(null);
                setVideoUrl(event.target.value);
              }}
              placeholder="https://example.com/video.mp4"
              className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-3 text-sm text-white placeholder:text-slate-500 focus:border-indigo-400 focus:outline-none"
            />
            <p className="text-[11px] leading-relaxed text-slate-500">
              Paste a <span className="text-slate-300">direct public video file</span> such as MP4, MOV, MKV, or WEBM.
              Maximum {limits?.maxUrlSizeMb ?? "—"}MB and {limits?.maxDurationMinutes ?? "—"} minutes. YouTube, TikTok, and other webpage links are not supported yet.
            </p>
            <button
              type="button"
              onClick={() => void submitUrl()}
              disabled={busy || !videoUrl.trim()}
              className="w-full rounded-xl bg-indigo-500 px-4 py-3.5 text-sm font-bold text-white transition active:scale-[0.99] active:bg-indigo-400 disabled:bg-white/5 disabled:text-slate-500"
            >
              Generate clips from URL
            </button>
          </div>
        )}

        {/* Options */}
        <div className="mt-4 grid grid-cols-2 gap-3">
          <label className="space-y-1">
            <span className="text-[11px] font-medium text-slate-400">Clips</span>
            <select
              value={clipCount}
              onChange={(event) => setClipCount(Number(event.target.value))}
              className="w-full rounded-lg border border-white/10 bg-black/30 px-2 py-2 text-xs text-white focus:border-indigo-400 focus:outline-none"
            >
              {Array.from({ length: limits?.maxClipCount ?? 8 }, (_, index) => index + 1).map((value) => (
                <option key={value} value={value}>
                  {value} clip{value > 1 ? "s" : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1">
            <span className="text-[11px] font-medium text-slate-400">Max length</span>
            <select
              value={maxClipSec}
              onChange={(event) => setMaxClipSec(Number(event.target.value))}
              className="w-full rounded-lg border border-white/10 bg-black/30 px-2 py-2 text-xs text-white focus:border-indigo-400 focus:outline-none"
            >
              {[20, 30, 45, 60, 75, 90].map((value) => (
                <option key={value} value={value}>
                  {value}s
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="mt-3 flex items-center justify-between rounded-xl bg-black/20 px-3 py-2.5">
          <span className="text-xs font-medium text-slate-300">Burn in captions</span>
          <input
            type="checkbox"
            checked={subtitles}
            onChange={(event) => setSubtitles(event.target.checked)}
            className="h-5 w-5 accent-indigo-500"
          />
        </label>
      </section>

      {/* Errors ---------------------------------------------------------- */}
      {error ? (
        <div className="rounded-2xl border border-red-500/30 bg-red-500/10 p-4">
          <p className="text-xs font-semibold text-red-200">{error.message}</p>
          {error.detail ? (
            <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap text-[11px] text-red-200/70">
              {error.detail}
            </pre>
          ) : null}
        </div>
      ) : null}

      {/* Active job ------------------------------------------------------ */}
      {activeJob ? (
        <section className="space-y-3">
          <JobProgress job={activeJob} />
          {activeJob.status === "failed" || activeJob.status === "partial" ? (
            <button
              type="button"
              onClick={() => void retry(activeJob.id)}
              className="w-full rounded-xl border border-white/15 bg-white/5 px-4 py-3 text-sm font-semibold text-white active:bg-white/10"
            >
              Retry this job
            </button>
          ) : null}

          {activeJob.clips.length ? (
            <div className="space-y-4">
              <h2 className="text-sm font-semibold text-white">
                Clips ({activeJob.clips.filter((clip) => clip.status === "ready").length}/
                {activeJob.clips.length})
              </h2>
              {activeJob.clips.map((clip) => (
                <ClipCard key={clip.id} clip={clip} />
              ))}
            </div>
          ) : null}

          {activeJob.status !== "processing" && activeJob.status !== "queued" ? (
            <button
              type="button"
              onClick={() => void remove(activeJob.id)}
              className="w-full rounded-xl px-4 py-2.5 text-[11px] font-medium text-slate-500 active:text-slate-300"
            >
              Delete job and files now
            </button>
          ) : null}
        </section>
      ) : null}

      {/* History --------------------------------------------------------- */}
      {history.length ? (
        <section className="space-y-2">
          <h2 className="px-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Recent jobs</h2>
          <div className="space-y-2">
            {history.map((job) => (
              <button
                key={job.id}
                type="button"
                onClick={() => setActiveJob(job)}
                className={`flex w-full items-center gap-3 rounded-xl border px-3 py-3 text-left transition ${
                  activeJob?.id === job.id
                    ? "border-indigo-400/40 bg-indigo-500/10"
                    : "border-white/10 bg-white/[0.02] active:bg-white/[0.06]"
                }`}
              >
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${
                    job.status === "completed"
                      ? "bg-emerald-400"
                      : job.status === "processing" || job.status === "queued"
                        ? "animate-pulse bg-indigo-400"
                        : job.status === "partial"
                          ? "bg-amber-400"
                          : "bg-red-400"
                  }`}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium text-slate-200">{job.sourceName}</span>
                  <span className="block truncate text-[11px] text-slate-500">
                    {new Date(job.createdAt).toLocaleString()} ·{" "}
                    {job.clips.filter((clip) => clip.status === "ready").length} clip(s)
                  </span>
                </span>
                <span className="shrink-0 text-[10px] uppercase text-slate-500">{job.status}</span>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      <details className="rounded-2xl border border-white/10 bg-white/[0.02] p-4">
        <summary className="cursor-pointer list-none text-xs font-semibold text-slate-300">
          Server health &amp; FFmpeg self-test
        </summary>
        <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
          Renders a real 4-second 9:16 clip with a burned caption to prove this host can encode video.
          Run it once after deploying.
        </p>
        <button
          type="button"
          onClick={() => void runSelfTest()}
          disabled={selfTestRunning}
          className="mt-3 w-full rounded-xl border border-white/15 bg-white/5 px-4 py-2.5 text-xs font-semibold text-white active:bg-white/10 disabled:opacity-50"
        >
          {selfTestRunning ? "Rendering test clip…" : selfTest ? "Run again" : "Run FFmpeg self-test"}
        </button>
        {selfTest ? (
          <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-black/40 p-3 text-[10px] leading-relaxed text-slate-300">
            {selfTest}
          </pre>
        ) : null}
      </details>

      <footer className="pt-2 text-[11px] leading-relaxed text-slate-600">
        {appConfig ? (
          <>
            Clips are temporary and deleted after {appConfig.limits.retentionHours}h.{" "}
            {appConfig.stats.clipsReady} clip(s) on disk ({appConfig.stats.storageMb}MB). Transcription:{" "}
            {appConfig.providers.groqConfigured ? appConfig.providers.transcribeModel : "not configured"}. Analysis:{" "}
            {appConfig.providers.groqConfigured
              ? `${appConfig.providers.groqModel} (Groq)`
              : "not configured"}
            {appConfig.providers.openrouterConfigured
              ? ` → ${appConfig.providers.openrouterModel} (OpenRouter fallback)`
              : ""}
            .
          </>
        ) : (
          "Loading server settings…"
        )}
      </footer>
    </main>
  );
}
