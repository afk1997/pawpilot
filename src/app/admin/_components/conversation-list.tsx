"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { flagBadge, formatWhen, staleMessage } from "./format";
import { usePolling } from "./polling";

type Row = {
  id: string; phone: string; name: string | null; language: string | null; mode: "agent" | "human"; flagged: boolean;
  flagReason: string | null; isTest: boolean; updatedAt: string; lastMessage: string | null; messageCount: number;
  lastDeliveryStatus: string | null;
};
const FILTERS = ["all", "flagged", "human", "test"] as const;
/** The search waits for this pause in typing, so each keystroke is not a request of its own. */
const SEARCH_DEBOUNCE_MS = 300;
const POLL_MS = 5000;

export function ConversationList() {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("all");
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");

  useEffect(() => { const t = setTimeout(() => setSearch(q), SEARCH_DEBOUNCE_MS); return () => clearTimeout(t); }, [q]);

  const { data: rows, lastOkAt, error } = usePolling<Row[]>(`/api/admin/conversations?filter=${filter}&q=${encodeURIComponent(search)}`, POLL_MS);

  return (
    <main className="min-h-screen bg-[#0f0f0f] text-white">
      <header className="flex items-center gap-3 border-b border-white/10 px-6 py-4">
        <h1 className="text-sm font-semibold">Arham Helpline Admin</h1>
        <nav className="ml-4 flex gap-1 text-xs">
          {FILTERS.map((f) => (
            <button key={f} onClick={() => setFilter(f)} className={`rounded px-2 py-1 ${filter === f ? "bg-emerald-500/20 text-emerald-300" : "text-white/50 hover:text-white"}`}>{f}</button>
          ))}
        </nav>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search phone or name" className="ml-auto w-56 rounded border border-white/10 bg-[#141414] px-2 py-1 text-xs" />
        <Link href="/test-chat" className="text-xs text-emerald-400">Test chat →</Link>
      </header>
      {error && <div role="alert" title={error.reason} className="border-b border-red-500/20 bg-red-500/10 px-6 py-2 text-xs text-red-300">{staleMessage(lastOkAt, error.at)}</div>}
      <ul className="divide-y divide-white/5">
        {rows === null && !error && <li className="px-6 py-8 text-xs text-white/40">Loading…</li>}
        {rows?.length === 0 && <li className="px-6 py-8 text-xs text-white/40">No conversations.</li>}
        {rows?.map((r) => {
          const flag = flagBadge(r);
          return (
            <li key={r.id}>
              <Link href={`/admin/${r.id}`} className="flex items-center gap-4 px-6 py-3 hover:bg-white/[0.03]">
                <div className="w-44 truncate text-sm">{r.name ?? r.phone}<div className="text-[11px] text-white/40">{r.phone}</div></div>
                <div className="flex-1 truncate text-xs text-white/60">{r.lastMessage ?? "—"}</div>
                <div className="flex gap-1 text-[10px] uppercase">
                  {r.lastDeliveryStatus === "failed" && <span className="rounded bg-red-500/20 px-1.5 py-0.5 text-red-300">send failed</span>}
                  {flag && <span className="rounded bg-red-500/20 px-1.5 py-0.5 text-red-300">{flag}</span>}
                  {r.mode === "human" && <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-amber-300">human</span>}
                  {r.language && <span className="rounded bg-white/10 px-1.5 py-0.5 text-white/60">{r.language}</span>}
                </div>
                <div className="w-32 text-right text-[11px] text-white/40">{r.messageCount} msgs<br />{formatWhen(r.updatedAt, lastOkAt)}</div>
              </Link>
            </li>
          );
        })}
      </ul>
    </main>
  );
}
