"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Transcript } from "../admin/_components/transcript";

type Row = { id: string; phone: string; language: string | null; lastMessage: string | null; updatedAt: string };
const LANGS = [["en", "English"], ["hi", "Hindi"], ["mr", "Marathi"], ["gu", "Gujarati"]] as const;
const API = "/api/test-chat/conversations";
/** The server refuses a longer message, so the box stops there. */
const MAX_CONTENT_CHARS = 2000;

/** What a refused request says went wrong: the error it names, else its status. */
async function refusal(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  return typeof body?.error === "string" ? body.error : `HTTP ${res.status}`;
}

const reason = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function TestChatClient() {
  const [rows, setRows] = useState<Row[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [lang, setLang] = useState<string>("en");
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [pollError, setPollError] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  // Bumped to poll the list at once; the restart also drops the answer of any poll still in flight.
  const [listVersion, setListVersion] = useState(0);

  useEffect(() => {
    let ignore = false;
    const poll = () => {
      fetch(API, { cache: "no-store" })
        .then(async (res) => {
          if (ignore) return;
          if (res.status === 401) { window.location.href = "/admin/login"; return; }
          if (!res.ok) throw new Error(await refusal(res));
          const next = (await res.json()) as Row[];
          if (ignore) return;
          setRows(next);
          setPollError(null);
        })
        .catch((err: unknown) => { if (!ignore) setPollError(`List not refreshing: ${reason(err)}`); });
    };
    poll();
    const t = setInterval(poll, 4000);
    return () => { ignore = true; clearInterval(t); };
  }, [listVersion]);

  async function create() {
    try {
      const res = await fetch(API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ language: lang }) });
      if (res.status === 401) { window.location.href = "/admin/login"; return; }
      if (!res.ok) throw new Error(await refusal(res));
      const c = (await res.json()) as Row;
      setCreateError(null);
      setSelected(c.id);
      setListVersion((v) => v + 1);
    } catch (err) {
      setCreateError(`New test chat failed: ${reason(err)}`);
    }
  }

  async function send() {
    const id = selected;
    const content = input.trim();
    if (!id || !content || sending) return;
    setSending(true);
    setInput("");
    try {
      const res = await fetch(`${API}/${id}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content }) });
      if (res.status === 401) { window.location.href = "/admin/login"; return; }
      if (!res.ok) throw new Error(await refusal(res));
      setSendError(null);
      setListVersion((v) => v + 1);
    } catch (err) {
      // Give the text back unless something new was typed meanwhile.
      setInput((current) => current || content);
      setSendError(`Not sent: ${reason(err)}`);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex h-screen bg-[#0f0f0f] text-white">
      <aside className="flex w-[280px] flex-col border-r border-white/10 bg-[#141414]">
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
          <div><div className="text-sm font-medium">Test chat</div><div className="text-[11px] text-white/50">Direct to the worker, no WhatsApp</div></div>
          <Link href="/admin" className="text-xs text-white/50 hover:text-white">Admin</Link>
        </div>
        <div className="flex gap-2 border-b border-white/10 px-4 py-2">
          <select value={lang} onChange={(e) => setLang(e.target.value)} className="rounded border border-white/10 bg-[#0f0f0f] px-2 py-1 text-xs">
            {LANGS.map(([code, label]) => <option key={code} value={code}>{label}</option>)}
          </select>
          <button onClick={create} className="rounded bg-emerald-500 px-3 py-1 text-xs font-medium text-black">+ New</button>
        </div>
        {(pollError || createError) && (
          <div role="alert" className="space-y-1 border-b border-white/10 px-4 py-2 text-[11px] text-red-400">
            {pollError && <div>{pollError}</div>}
            {createError && <div>{createError}</div>}
          </div>
        )}
        <div className="flex-1 overflow-y-auto">
          {rows.map((r) => (
            <button key={r.id} onClick={() => setSelected(r.id)} className={`block w-full border-b border-white/5 px-4 py-3 text-left ${selected === r.id ? "bg-white/[0.06]" : "hover:bg-white/[0.03]"}`}>
              <div className="flex justify-between text-xs"><span>{r.phone.replace("+91TEST_", "test-")}</span><span className="text-white/40">{(r.language ?? "en").toUpperCase()}</span></div>
              {r.lastMessage && <div className="mt-1 truncate text-[11px] text-white/50">{r.lastMessage}</div>}
            </button>
          ))}
        </div>
      </aside>
      <main className="flex flex-1 flex-col">
        {!selected ? (
          <div className="flex flex-1 items-center justify-center text-sm text-white/40">Create or select a test chat. Keep <code className="mx-1">npm run worker:dev</code> running to get replies.</div>
        ) : (
          <>
            {/* Keyed, so switching chats starts a fresh transcript and an answer still in flight for the old one is dropped. */}
            <div className="min-h-0 flex-1"><Transcript key={selected} id={selected} apiBase={API} pollMs={1500} /></div>
            {sendError && <div role="alert" className="border-t border-white/10 px-6 py-2 text-xs text-red-400">{sendError}</div>}
            <footer className="flex gap-2 border-t border-white/10 px-6 py-3">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }}
                rows={2}
                maxLength={MAX_CONTENT_CHARS}
                placeholder="Type as the reporter… (Enter to send)"
                className="flex-1 resize-none rounded-md border border-white/10 bg-[#141414] px-3 py-2 text-sm focus:border-emerald-500/40 focus:outline-none"
              />
              <button onClick={send} disabled={!input.trim() || sending} className="rounded-md bg-emerald-500 px-4 text-sm font-medium text-black disabled:opacity-30">Send</button>
            </footer>
          </>
        )}
      </main>
    </div>
  );
}
