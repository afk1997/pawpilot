"use client";

import { useState } from "react";

export type TurnRow = {
  id: string; status: string; model: string | null; effort: string | null; structuredOutput: unknown; toolCalls: unknown;
  usage: unknown; latencyMs: number | null; sessionId: string | null; error: string | null; scrubbed: boolean; createdAt: string;
};

export function TurnDetails({ turn }: { turn: TurnRow }) {
  const [open, setOpen] = useState(false);
  const so = (turn.structuredOutput ?? {}) as { intent?: string; language?: string; needs_human?: boolean; notes?: string | null; location?: { city: string | null; area: string | null } };
  return (
    <div className="mt-1 text-[11px] text-white/50">
      <button onClick={() => setOpen(!open)} className="hover:text-white">
        {open ? "▾" : "▸"} turn {turn.status}{turn.model ? ` · ${turn.model}` : ""}{turn.latencyMs != null ? ` · ${turn.latencyMs} ms` : ""}{turn.scrubbed ? " · scrubbed" : ""}{so.intent ? ` · ${so.intent}` : ""}{so.needs_human ? " · needs human" : ""}
      </button>
      {open && (
        <div className="mt-1 space-y-1 rounded border border-white/10 bg-black/30 p-2">
          {so.notes && <div>notes: {so.notes}</div>}
          {so.location && <div>location: {[so.location.area, so.location.city].filter(Boolean).join(", ") || "unknown"}</div>}
          {turn.error && <div className="text-red-300">error: {turn.error}</div>}
          <div>tool calls:</div>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap text-[10px]">{JSON.stringify(turn.toolCalls ?? [], null, 1)}</pre>
          <div>usage:</div>
          <pre className="max-h-32 overflow-auto whitespace-pre-wrap text-[10px]">{JSON.stringify(turn.usage ?? {}, null, 1)}</pre>
        </div>
      )}
    </div>
  );
}
