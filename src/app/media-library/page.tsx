"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

const MUSIC_TAGS = ["Motivational", "Cinematic", "Dramatic", "Powerful", "Nostalgic", "Mysterious", "Chaotic"];
const EFFECT_TAGS = ["Whoosh", "Impact", "Transition", "Notification", "Riser", "Hit", "Ambient"];

type Category = "music" | "sound_effect";
type Asset = {
  id: string;
  category: Category;
  name: string;
  fileName: string;
  contentType: string;
  fileSizeBytes: number;
  durationSec: number | null;
  tags: string[];
  analysis: { estimatedBpm: number | null; vibe: string } | null;
  playbackUrl: string;
};

function formatDuration(seconds: number | null) {
  if (seconds === null || !Number.isFinite(seconds)) return "Duration unknown";
  return `${Math.floor(seconds / 60)}:${Math.round(seconds % 60).toString().padStart(2, "0")}`;
}

export default function MediaLibraryPage() {
  const [category, setCategory] = useState<Category>("music");
  const [assets, setAssets] = useState<Asset[]>([]);
  const [query, setQuery] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [customTag, setCustomTag] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadPhase, setUploadPhase] = useState<"uploading" | "saving" | null>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/media?category=${category}`, { cache: "no-store" });
      const data = (await response.json()) as { assets?: Asset[]; error?: string };
      if (!response.ok) throw new Error(data.error || "Could not load the media library.");
      setAssets(data.assets ?? []);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [category]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const switchCategory = (value: Category) => {
    setCategory(value);
    setTags([]);
    setTagFilter("");
  };

  const visible = useMemo(() => assets.filter((asset) => {
    const text = `${asset.name} ${asset.fileName} ${asset.tags.join(" ")}`.toLowerCase();
    return (!query.trim() || text.includes(query.trim().toLowerCase())) && (!tagFilter || asset.tags.includes(tagFilter));
  }), [assets, query, tagFilter]);
  const suggestions = category === "music" ? MUSIC_TAGS : EFFECT_TAGS;
  const availableTags = [...new Set([...suggestions, ...assets.flatMap((asset) => asset.tags)])];

  const upload = useCallback(() => {
    if (!file) { setError("Choose an audio file first."); return; }
    setUploading(true);
    setUploadPhase("uploading");
    setError(null);
    setProgress(0);
    const finalTags = [...new Set([...tags, ...(customTag.trim() ? [customTag.trim()] : [])])];
    const params = new URLSearchParams({ category, name: name.trim(), tags: finalTags.join(",") });
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/media/upload?${params}`);
    xhr.timeout = 180_000;
    xhr.setRequestHeader("x-file-name", encodeURIComponent(file.name));
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    xhr.upload.onprogress = (event) => event.lengthComputable && setProgress(Math.round(event.loaded / event.total * 100));
    xhr.upload.onload = () => {
      setProgress(100);
      setUploadPhase("saving");
    };
    xhr.onload = () => {
      setUploading(false);
      setUploadPhase(null);
      try {
        const data = JSON.parse(xhr.responseText) as { asset?: Asset; error?: string };
        if (xhr.status < 200 || xhr.status >= 300 || !data.asset) throw new Error(data.error || `Upload failed (${xhr.status})`);
        setFile(null); setName(""); setTags([]); setCustomTag(""); setProgress(0);
        const input = document.getElementById("library-file") as HTMLInputElement | null;
        if (input) input.value = "";
        setAssets((current) => [data.asset as Asset, ...current.filter((asset) => asset.id !== data.asset?.id)]);
      } catch (err) { setError((err as Error).message); }
    };
    xhr.onerror = () => {
      setUploading(false);
      setUploadPhase(null);
      setError("Upload failed before it could be saved. Check your connection and try again.");
    };
    xhr.ontimeout = () => {
      setUploading(false);
      setUploadPhase(null);
      setError("The upload request timed out after 3 minutes. Refresh the library before retrying to avoid a duplicate if the server finished saving it.");
    };
    xhr.onabort = () => {
      setUploading(false);
      setUploadPhase(null);
    };
    xhr.send(file);
  }, [category, customTag, file, name, tags]);

  const remove = useCallback(async (asset: Asset) => {
    if (!window.confirm(`Delete “${asset.name}” permanently?`)) return;
    const response = await fetch(`/api/media/${asset.id}`, { method: "DELETE" });
    const data = (await response.json()) as { error?: string };
    if (!response.ok) { setError(data.error || "Delete failed."); return; }
    setAssets((current) => current.filter((item) => item.id !== asset.id));
  }, []);

  return (
    <main className="space-y-5">
      <header className="flex items-center justify-between gap-3">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-indigo-400">Reusable cloud assets</p>
          <h1 className="mt-1 text-2xl font-bold text-white">Media Library</h1>
        </div>
        <Link href="/" className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-slate-300">← Clip creator</Link>
      </header>

      <div className="grid grid-cols-2 gap-1 rounded-xl bg-white/[0.04] p-1">
        <button onClick={() => switchCategory("music")} className={`rounded-lg px-3 py-2.5 text-xs font-semibold ${category === "music" ? "bg-indigo-500 text-white" : "text-slate-400"}`}>🎵 Background Music</button>
        <button onClick={() => switchCategory("sound_effect")} className={`rounded-lg px-3 py-2.5 text-xs font-semibold ${category === "sound_effect" ? "bg-indigo-500 text-white" : "text-slate-400"}`}>🔊 Sound Effects</button>
      </div>

      <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
        <h2 className="text-sm font-semibold text-white">Upload once, reuse anywhere</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="cursor-pointer rounded-xl border border-dashed border-white/15 bg-black/20 p-3 text-xs text-slate-400">
            <span className="block truncate">{file?.name || "Choose MP3, WAV, M4A, AAC, or OGG"}</span>
            <input id="library-file" type="file" accept="audio/*,.mp3,.wav,.m4a,.aac,.ogg" className="hidden" onChange={(event) => { setFile(event.target.files?.[0] ?? null); setName(event.target.files?.[0]?.name.replace(/\.[^.]+$/, "") ?? ""); }} />
          </label>
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Display name" className="rounded-xl border border-white/10 bg-black/20 px-3 py-2.5 text-xs text-white outline-none focus:border-indigo-400" />
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {suggestions.map((tag) => <button key={tag} type="button" onClick={() => setTags((current) => current.includes(tag) ? current.filter((item) => item !== tag) : [...current, tag])} className={`rounded-full px-2.5 py-1 text-[10px] ring-1 ${tags.includes(tag) ? "bg-fuchsia-500/20 text-fuchsia-200 ring-fuchsia-400/50" : "bg-white/5 text-slate-400 ring-white/10"}`}>{tag}</button>)}
        </div>
        <input value={customTag} onChange={(event) => setCustomTag(event.target.value)} placeholder="Optional custom tag" className="mt-3 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2.5 text-xs text-white outline-none focus:border-indigo-400" />
        {uploading ? (
          <div className="mt-3">
            <p className="mb-1.5 text-[10px] text-slate-400">
              {uploadPhase === "saving" ? "Saving to library…" : `Uploading… ${progress}%`}
            </p>
            <div className="h-1.5 overflow-hidden rounded bg-white/10">
              <div className={`h-full bg-indigo-400 transition-all ${uploadPhase === "saving" ? "animate-pulse" : ""}`} style={{ width: `${progress}%` }} />
            </div>
          </div>
        ) : null}
        <button disabled={!file || uploading} onClick={upload} className="mt-3 w-full rounded-xl bg-indigo-500 px-4 py-2.5 text-xs font-semibold text-white disabled:opacity-40">{uploading ? (uploadPhase === "saving" ? "Saving to library…" : `Uploading… ${progress}%`) : `Add to ${category === "music" ? "Music" : "Sound Effects"}`}</button>
      </section>

      <section className="space-y-3">
        <div className="flex gap-2">
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search name or tag…" className="min-w-0 flex-1 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2.5 text-xs text-white outline-none focus:border-indigo-400" />
          <select value={tagFilter} onChange={(event) => setTagFilter(event.target.value)} className="rounded-xl border border-white/10 bg-[#0d1220] px-2 text-xs text-slate-300"><option value="">All tags</option>{availableTags.map((tag) => <option key={tag}>{tag}</option>)}</select>
        </div>
        {error ? <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-300">{error}</div> : null}
        {!visible.length && !error ? <div className="rounded-2xl border border-dashed border-white/10 py-10 text-center text-xs text-slate-500">No {category === "music" ? "music tracks" : "sound effects"} found.</div> : null}
        {visible.map((asset) => (
          <article key={asset.id} className="rounded-2xl border border-white/10 bg-white/[0.03] p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0"><h3 className="truncate text-sm font-semibold text-white">{asset.name}</h3><p className="mt-0.5 text-[10px] text-slate-500">{formatDuration(asset.durationSec)} · {(asset.fileSizeBytes / 1024 / 1024).toFixed(1)}MB · {asset.fileName.split(".").pop()?.toUpperCase()}{asset.analysis?.estimatedBpm ? ` · ~${asset.analysis.estimatedBpm} BPM` : ""}</p></div>
              <button onClick={() => void remove(asset)} className="rounded-lg px-2 py-1 text-[10px] text-red-300 hover:bg-red-500/10">Delete</button>
            </div>
            <audio controls preload="none" src={asset.playbackUrl} className="mt-3 h-8 w-full" />
            {asset.tags.length ? <div className="mt-2 flex flex-wrap gap-1">{asset.tags.map((tag) => <span key={tag} className="rounded-full bg-white/5 px-2 py-0.5 text-[9px] text-slate-400">{tag}</span>)}</div> : null}
          </article>
        ))}
      </section>
    </main>
  );
}
