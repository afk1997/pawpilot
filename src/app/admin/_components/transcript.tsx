"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { TurnDetails, type TurnRow } from "./turn-details";

type Msg = { id: string; role: "user" | "assistant"; origin: string; kind: string; content: string; contentTemplate: string | null; deliveryStatus: string | null; error: string | null; turnId: string | null; createdAt: string; placeLabel: string | null; mediaUrl: string | null };
type Detail = { conversation: { id: string; phone: string; name: string | null; language: string | null; mode: string; flagged: boolean; flagReason: string | null; isTest: boolean }; messages: Msg[]; turns: TurnRow[] };

export function Transcript({ id, apiBase = "/api/admin/conversations", pollMs = 3000 }: { id: string; apiBase?: string; pollMs?: number }) {
  const [d, setD] = useState<Detail | null>(null);
  const load = useCallback(async () => {
    const res = await fetch(`${apiBase}/${id}`, { cache: "no-store" });
    if (res.status === 401) { window.location.href = "/admin/login"; return; }
    if (res.ok) setD(await res.json());
  }, [apiBase, id]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- load() sets state only after its fetch resolves, never during the effect.
  useEffect(() => { load(); const t = setInterval(load, pollMs); return () => clearInterval(t); }, [load, pollMs]);
  if (!d) return <div className="p-6 text-xs text-white/40">Loading…</div>;
  const turnsById = new Map(d.turns.map((t) => [t.id, t]));
  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-white/10 px-6 py-3 text-sm">
        <Link href="/admin" className="text-white/40 hover:text-white">←</Link>
        <span className="font-medium">{d.conversation.name ?? d.conversation.phone}</span>
        <span className="text-xs text-white/40">{d.conversation.phone} · {d.conversation.language ?? "?"} · {d.conversation.mode}{d.conversation.flagged ? ` · flagged: ${d.conversation.flagReason}` : ""}</span>
      </header>
      <div className="flex-1 space-y-3 overflow-y-auto px-6 py-4">
        {d.messages.map((m) => {
          const user = m.role === "user";
          const turn = m.turnId ? turnsById.get(m.turnId) : undefined;
          return (
            <div key={m.id} className={`flex ${user ? "justify-start" : "justify-end"}`}>
              <div className={`max-w-[70%] rounded-2xl px-4 py-2 text-sm ${user ? "bg-white/[0.07]" : "bg-emerald-700/80"}`}>
                {m.kind !== "text" && <div className="mb-1 text-[10px] uppercase text-white/50">{m.kind}{m.placeLabel ? ` · ${m.placeLabel}` : ""}{m.mediaUrl ? " · media" : ""}</div>}
                <p className="whitespace-pre-wrap">{m.content}</p>
                <div className="mt-1 text-[10px] text-white/40">
                  {new Date(m.createdAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })} · {m.origin}{m.deliveryStatus ? ` · ${m.deliveryStatus}` : ""}{m.error ? ` · ${m.error}` : ""}
                </div>
                {turn && <TurnDetails turn={turn} />}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
