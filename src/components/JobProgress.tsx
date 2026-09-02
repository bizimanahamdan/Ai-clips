"use client";

import type { ApiJob } from "@/lib/types";

const STATUS_STYLES: Record<string, string> = {
  queued: "bg-slate-500/20 text-slate-300 ring-slate-400/30",
  processing: "bg-indigo-500/20 text-indigo-300 ring-indigo-400/30",
  completed: "bg-emerald-500/20 text-emerald-300 ring-emerald-400/30",
  partial: "bg-amber-500/20 text-amber-300 ring-amber-400/30",
  failed: "bg-red-500/20 text-red-300 ring-red-400/30",
};

export function JobProgress({ job }: { job: ApiJob }) {
  const active = job.status === "queued" || job.status === "processing";
  const style = STATUS_STYLES[job.status] ?? STATUS_STYLES.queued;

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-white">{job.stageLabel}</p>
          <p className="mt-0.5 truncate text-xs text-slate-400">
            {job.stageDetail || job.sourceName}
          </p>
        </div>
        <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase ring-1 ${style}`}>
          {job.status}
        </span>
      </div>

      <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-white/10">
        <div
          className={`h-full rounded-full transition-all duration-500 ${
            job.status === "failed"
              ? "bg-red-500"
              : job.status === "completed"
                ? "bg-emerald-500"
                : "bg-indigo-500"
          }`}
          style={{ width: `${Math.max(3, Math.min(100, job.progress))}%` }}
        />
      </div>

      <div className="mt-2 flex items-center gap-2 text-[10px] text-slate-500">
        <span className="rounded bg-white/5 px-1.5 py-0.5">{job.outputFormat}</span>
        {job.musicFileName ? <span className="min-w-0 truncate">♫ {job.musicFileName}</span> : job.musicAssetIds.length ? <span>{job.mediaMode === "auto" ? "✨ Auto-match" : `♫ ${job.musicAssetIds.length} track(s)`}</span> : <span>No music</span>}
        {job.soundEffectAssetIds.length ? <span>· 🔊 {job.soundEffectAssetIds.length}</span> : null}
      </div>

      <div className="mt-2 flex items-center justify-between text-[11px] text-slate-500">
        <span>{job.progress}%</span>
        <span className="truncate">
          {job.analysisProvider && job.analysisModel
            ? `${job.analysisProvider} · ${job.analysisModel}`
            : job.durationSec
              ? `${Math.floor(job.durationSec / 60)}m ${Math.round(job.durationSec % 60)}s source`
              : ""}
        </span>
      </div>

      {job.error ? (
        <div className="mt-3 rounded-xl border border-red-500/30 bg-red-500/10 p-3">
          <p className="text-xs font-semibold text-red-300">{job.error.message}</p>
          {job.error.detail ? (
            <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words text-[11px] leading-relaxed text-red-200/70">
              {job.error.detail}
            </pre>
          ) : null}
        </div>
      ) : null}

      {job.events.length ? (
        <details className="mt-3 group">
          <summary className="cursor-pointer list-none text-[11px] font-medium text-slate-400 hover:text-slate-300">
            Processing log ({job.events.length})
          </summary>
          <div className="mt-2 max-h-56 space-y-1 overflow-auto rounded-xl bg-black/40 p-3">
            {job.events.map((event) => (
              <p
                key={event.id}
                className={`text-[11px] leading-relaxed ${
                  event.level === "error"
                    ? "text-red-300"
                    : event.level === "warn"
                      ? "text-amber-300"
                      : "text-slate-400"
                }`}
              >
                <span className="text-slate-600">[{event.stage}]</span> {event.message}
              </p>
            ))}
          </div>
        </details>
      ) : null}

      {job.transcriptPreview && job.status !== "processing" ? (
        <details className="mt-2">
          <summary className="cursor-pointer list-none text-[11px] font-medium text-slate-400 hover:text-slate-300">
            Transcript preview
          </summary>
          <p className="mt-2 max-h-40 overflow-auto rounded-xl bg-black/40 p-3 text-[11px] leading-relaxed text-slate-400">
            {job.transcriptPreview}
          </p>
        </details>
      ) : null}

      {active ? null : null}
    </div>
  );
}
