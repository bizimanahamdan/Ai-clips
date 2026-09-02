"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

type Ref = { type: string; id: string; field: string; label: string };
type Item = { key: string; sizeBytes: number; lastModified: string | null; etag: string | null; referenced: boolean; references: Ref[] };
type Listing = { refreshedAt: string; totalObjects: number; totalSizeBytes: number; filteredObjects: number; prefixes: string[]; page: number; pages: number; objects: Item[] };
const bytes = (value: number) => value < 1024 ? `${value} B` : value < 1024 ** 2 ? `${(value / 1024).toFixed(1)} KB` : value < 1024 ** 3 ? `${(value / 1024 ** 2).toFixed(1)} MB` : `${(value / 1024 ** 3).toFixed(2)} GB`;

export default function StorageAdminPage() {
  const [password, setPassword] = useState("");
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [data, setData] = useState<Listing | null>(null);
  const [query, setQuery] = useState("");
  const [prefix, setPrefix] = useState("");
  const [status, setStatus] = useState("all");
  const [sort, setSort] = useState("key");
  const [direction, setDirection] = useState("asc");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Item | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true); setError(null);
    const params = new URLSearchParams({ q: query, prefix, status, sort, direction, page: String(page), pageSize: "50" });
    try {
      const response = await fetch(`/api/admin/storage?${params}`, { cache: "no-store" });
      const result = await response.json() as Listing & { error?: string };
      if (response.status === 401) { setAuthenticated(false); setData(null); return; }
      if (!response.ok) throw new Error(result.error || `Refresh failed (${response.status})`);
      setAuthenticated(true); setData(result);
    } catch (err) { setError((err as Error).message); }
    finally { setLoading(false); }
  }, [query, prefix, status, sort, direction, page]);

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  async function login(event: React.FormEvent) {
    event.preventDefault(); setError(null);
    const response = await fetch("/api/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
    const result = await response.json() as { error?: string };
    if (!response.ok) return setError(result.error || "Login failed.");
    setPassword(""); setAuthenticated(true); await refresh();
  }

  async function removeObject() {
    if (!selected) return;
    const response = await fetch("/api/admin/storage/object", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: selected.key, confirmation }) });
    const result = await response.json() as { error?: string };
    if (!response.ok) return setError(result.error || "Delete failed.");
    setSelected(null); setConfirmation(""); await refresh();
  }

  if (authenticated === false) return <main className="mx-auto min-h-screen max-w-md p-6 pt-20 text-slate-100"><Link href="/" className="text-xs text-indigo-300">← ClipForge</Link><form onSubmit={login} className="mt-8 space-y-4 rounded-2xl border border-white/10 bg-white/[0.03] p-6"><h1 className="text-xl font-bold">Admin storage login</h1><p className="text-xs text-slate-400">Enter the server-side ADMIN_PASSWORD. It is exchanged for an HttpOnly cookie and never stored in browser JavaScript.</p><input autoFocus type="password" value={password} onChange={(event) => setPassword(event.target.value)} className="w-full rounded-xl border border-white/10 bg-slate-950 p-3 text-sm" placeholder="Admin password"/><button className="w-full rounded-xl bg-indigo-500 p-3 text-sm font-semibold">Sign in</button>{error ? <p className="text-xs text-red-300">{error}</p> : null}</form></main>;

  return <main className="mx-auto min-h-screen max-w-7xl space-y-5 p-4 text-slate-100 sm:p-8">
    <header className="flex flex-wrap items-center justify-between gap-3"><div><Link href="/" className="text-xs text-indigo-300">← ClipForge</Link><h1 className="mt-1 text-2xl font-bold">Live R2 explorer</h1><p className="text-xs text-slate-400">my-clips-storage · live keys reconciled against database references</p></div><div className="flex gap-2"><button onClick={() => void refresh()} disabled={loading} className="rounded-lg bg-indigo-500 px-4 py-2 text-xs font-semibold disabled:opacity-50">{loading ? "Refreshing…" : "Refresh live R2"}</button><button onClick={async () => { await fetch("/api/admin/login", { method: "DELETE" }); setAuthenticated(false); }} className="rounded-lg border border-white/10 px-3 py-2 text-xs">Sign out</button></div></header>
    {error ? <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-200">{error}</div> : null}
    {data ? <>
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">{[["Objects", data.totalObjects.toLocaleString()], ["Total size", bytes(data.totalSizeBytes)], ["Matching", data.filteredObjects.toLocaleString()], ["Refreshed", new Date(data.refreshedAt).toLocaleTimeString()]].map(([label,value]) => <div key={label} className="rounded-xl border border-white/10 bg-white/[0.03] p-4"><div className="text-[10px] uppercase text-slate-500">{label}</div><div className="mt-1 text-lg font-semibold">{value}</div></div>)}</section>
      <section className="grid gap-2 rounded-xl border border-white/10 bg-white/[0.03] p-3 sm:grid-cols-5"><input value={query} onChange={(e) => { setQuery(e.target.value); setPage(1); }} placeholder="Search exact key text…" className="rounded-lg bg-slate-950 p-2 text-xs sm:col-span-2"/><select value={prefix} onChange={(e) => { setPrefix(e.target.value === "(root)" ? "" : e.target.value); setPage(1); }} className="rounded-lg bg-slate-950 p-2 text-xs"><option value="">All prefixes</option>{data.prefixes.map((p) => <option key={p}>{p}</option>)}</select><select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className="rounded-lg bg-slate-950 p-2 text-xs"><option value="all">All states</option><option value="referenced">Referenced</option><option value="orphaned">Orphaned</option></select><div className="flex gap-1"><select value={sort} onChange={(e) => setSort(e.target.value)} className="min-w-0 flex-1 rounded-lg bg-slate-950 p-2 text-xs"><option value="key">Key</option><option value="size">Size</option><option value="date">Modified</option></select><button onClick={() => setDirection(direction === "asc" ? "desc" : "asc")} className="rounded-lg border border-white/10 px-3 text-xs">{direction === "asc" ? "↑" : "↓"}</button></div></section>
      <div className="overflow-x-auto rounded-xl border border-white/10"><table className="w-full min-w-[800px] text-left text-xs"><thead className="bg-white/5 text-slate-400"><tr><th className="p-3">Exact R2 key</th><th>State</th><th>Size</th><th>Modified</th><th className="p-3">Actions</th></tr></thead><tbody>{data.objects.map((item) => <tr key={item.key} className="border-t border-white/5"><td className="max-w-xl break-all p-3 font-mono text-[11px]">{item.key}</td><td><span className={`rounded-full px-2 py-1 text-[10px] font-bold ${item.referenced ? "bg-emerald-500/15 text-emerald-300" : "bg-amber-500/15 text-amber-300"}`}>{item.referenced ? "REFERENCED" : "ORPHANED"}</span></td><td>{bytes(item.sizeBytes)}</td><td>{item.lastModified ? new Date(item.lastModified).toLocaleString() : "—"}</td><td className="p-3"><div className="flex gap-2"><button onClick={() => { setSelected(item); setConfirmation(""); }} className="text-indigo-300">Details</button><button onClick={() => void navigator.clipboard.writeText(item.key)} className="text-slate-300">Copy</button><a href={`/api/admin/storage/object?download=1&key=${encodeURIComponent(item.key)}`} className="text-slate-300">Download</a></div></td></tr>)}</tbody></table></div>
      <div className="flex items-center justify-center gap-3 text-xs"><button disabled={page <= 1} onClick={() => setPage(page - 1)} className="rounded border border-white/10 px-3 py-2 disabled:opacity-30">Previous</button><span>Page {data.page} of {data.pages}</span><button disabled={page >= data.pages} onClick={() => setPage(page + 1)} className="rounded border border-white/10 px-3 py-2 disabled:opacity-30">Next</button></div>
    </> : <p className="text-sm text-slate-400">Loading live R2 inventory…</p>}
    {selected ? <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4"><div className="max-h-[90vh] w-full max-w-2xl overflow-auto rounded-2xl border border-white/10 bg-slate-950 p-5"><div className="flex justify-between"><h2 className="font-semibold">Object details</h2><button onClick={() => setSelected(null)}>✕</button></div><p className="mt-4 break-all font-mono text-xs">{selected.key}</p><p className="mt-2 text-xs text-slate-400">{bytes(selected.sizeBytes)} · ETag {selected.etag || "—"}</p><h3 className="mt-5 text-xs font-semibold">Database references</h3>{selected.references.length ? <ul className="mt-2 space-y-1">{selected.references.map((ref) => <li key={`${ref.type}-${ref.id}-${ref.field}`} className="rounded bg-white/5 p-2 text-xs">{ref.type} · {ref.label} · {ref.id} · {ref.field}</li>)}</ul> : <p className="mt-2 text-xs text-amber-300">ORPHANED is diagnostic only. Nothing is automatically deleted.</p>}<div className="mt-6 rounded-xl border border-red-500/30 bg-red-500/5 p-3"><p className="text-xs font-semibold text-red-200">Permanent R2 deletion</p><p className="mt-1 text-[11px] text-red-200/70">Database references are always preserved. {selected.referenced ? "This referenced object may break jobs, clips, or Media Library assets." : "This orphan has no current exact-key database reference."}</p><p className="mt-2 break-all text-[10px] text-slate-400">Type: {selected.referenced ? `DELETE REFERENCED ${selected.key}` : `DELETE ${selected.key}`}</p><input value={confirmation} onChange={(e) => setConfirmation(e.target.value)} className="mt-2 w-full rounded bg-black p-2 text-xs"/><button onClick={() => void removeObject()} className="mt-2 rounded bg-red-600 px-3 py-2 text-xs font-semibold">Delete permanently</button></div></div></div> : null}
  </main>;
}
