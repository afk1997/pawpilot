"use client";

import Link from "next/link";
import { TurnDetails, type TurnRow } from "./turn-details";
import { buildTimeline, type Msg } from "./timeline";
import { coordinates, flagLabel, formatWhen, mapsUrl, staleMessage } from "./format";
import { usePolling } from "./polling";

type Detail = { conversation: { id: string; phone: string; name: string | null; language: string | null; mode: string; flagged: boolean; flagReason: string | null; isTest: boolean }; messages: Msg[]; turns: TurnRow[] };

/** `backHref` is where the back arrow and the back link go: the page that lists this conversation. */
export function Transcript({ id, apiBase = "/api/admin/conversations", pollMs = 3000, backHref = "/admin" }: { id: string; apiBase?: string; pollMs?: number; backHref?: string }) {
  // Keyed by the conversation, so another id starts from nothing and answers still due for the old one are dropped.
  return <ConversationTranscript key={`${apiBase}/${id}`} url={`${apiBase}/${id}`} pollMs={pollMs} backHref={backHref} />;
}

function BackLink({ href }: { href: string }) {
  return <Link href={href} className="text-xs text-emerald-400 hover:text-emerald-300">← Back to conversations</Link>;
}

function ConversationTranscript({ url, pollMs, backHref }: { url: string; pollMs: number; backHref: string }) {
  const { data: d, lastOkAt, error, notFound } = usePolling<Detail>(url, pollMs);
  if (notFound) return <div className="space-y-3 p-6 text-sm"><p>Conversation not found</p><BackLink href={backHref} /></div>;
  const banner = error && <div role="alert" title={error.reason} className="border-b border-red-500/20 bg-red-500/10 px-6 py-2 text-xs text-red-300">{staleMessage(lastOkAt, error.at)}</div>;
  if (!d) return error ? <div>{banner}<div className="p-6"><BackLink href={backHref} /></div></div> : <div className="p-6 text-xs text-white/40">Loading…</div>;
  const turnsById = new Map(d.turns.map((t) => [t.id, t]));
  const c = d.conversation;
  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-white/10 px-6 py-3 text-sm">
        <Link href={backHref} className="text-white/40 hover:text-white">←</Link>
        <span className="font-medium">{c.name ?? c.phone}</span>
        <span className="text-xs text-white/40">{c.phone} · {c.language ?? "?"} · {c.mode}{c.flagged ? ` · flagged${c.flagReason ? `: ${flagLabel(c.flagReason)}` : ""}` : ""}</span>
      </header>
      {banner}
      <div className="flex-1 space-y-3 overflow-y-auto px-6 py-4">
        {buildTimeline(d.messages, d.turns).map((item) => {
          if (item.kind === "turn") {
            const t = item.turn;
            return (
              <div key={`turn-${t.id}`} className="flex justify-center">
                <div className="max-w-[70%] rounded-lg border border-red-500/20 bg-red-500/[0.06] px-3 py-1.5 text-[11px] text-red-200/80">
                  {formatWhen(t.createdAt, lastOkAt)} · no reply from this turn{t.error ? `: ${t.error.split(":")[0]}` : ""}
                  <TurnDetails turn={t} />
                </div>
              </div>
            );
          }
          const m = item.message;
          const user = m.role === "user";
          const turn = m.turnId ? turnsById.get(m.turnId) : undefined;
          const pin = m.kind === "location" && m.lat != null && m.lng != null ? { lat: m.lat, lng: m.lng } : null;
          return (
            <div key={m.id} className={`flex ${user ? "justify-start" : "justify-end"}`}>
              <div className={`max-w-[70%] rounded-2xl px-4 py-2 text-sm ${user ? "bg-white/[0.07]" : "bg-emerald-700/80"}`}>
                {m.kind !== "text" && <div className="mb-1 text-[10px] uppercase text-white/50">{m.kind}{m.placeLabel ? ` · ${m.placeLabel}` : ""}{m.mediaUrl ? " · media" : ""}</div>}
                {m.content && <p className="whitespace-pre-wrap">{m.content}</p>}
                {pin && <a href={mapsUrl(pin.lat, pin.lng)} target="_blank" rel="noopener noreferrer" className="text-xs underline">{coordinates(pin.lat, pin.lng)}</a>}
                {m.kind === "location" && !pin && !m.content && <p className="text-xs text-white/40">no coordinates</p>}
                <div className="mt-1 text-[10px] text-white/40">
                  {formatWhen(m.createdAt, lastOkAt)} · {m.origin}{m.deliveryStatus ? ` · ${m.deliveryStatus}` : ""}{m.error ? ` · ${m.error}` : ""}
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
