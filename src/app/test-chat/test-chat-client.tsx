"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { MAX_CONTENT_CHARS } from "@/server/admin/test-chat";
import type { Language } from "@/server/types";
import { staleMessage } from "../admin/_components/format";
import { NOTHING_YET, startPolling, type PollState } from "../admin/_components/polling";
import { Transcript } from "../admin/_components/transcript";

type Row = { id: string; phone: string; language: string | null; lastMessage: string | null; updatedAt: string };
const API = "/api/test-chat/conversations";
const LIST_POLL_MS = 4000;
const LANGS: Record<Language, string> = { en: "English", hi: "Hindi", mr: "Marathi", gu: "Gujarati" };
/** Sends no language, so the bot detects it from the first message, as it does on WhatsApp. */
const AUTO = "auto";
type LanguageChoice = Language | typeof AUTO;
/** The line under the transcript: why the last message was not sent, or that it was stored with no turn queued yet. */
type SendNote = { tone: "error" | "warn"; text: string };

/** What a refused request says went wrong: the error it names, else its status. */
async function refusal(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  return typeof body?.error === "string" ? body.error : `HTTP ${res.status}`;
}

const reason = (err: unknown) => (err instanceof Error ? err.message : String(err));
const toLogin = () => window.location.assign("/admin/login");

export function TestChatClient() {
  const [list, setList] = useState<PollState<Row[]>>(NOTHING_YET);
  // Bumped to poll the list at once; the restart also drops any answer still due to the old poll.
  const [listVersion, setListVersion] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  // The chat on screen, for a send that finishes after a switch: it must not touch the new chat's composer.
  const selectedRef = useRef<string | null>(null);
  const [lang, setLang] = useState<LanguageChoice>(AUTO);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [sendNote, setSendNote] = useState<SendNote | null>(null);

  useEffect(() => startPolling<Row[]>(API, LIST_POLL_MS, setList, toLogin), [listVersion]);

  /** Opens a chat with an empty composer and no note from the chat before. */
  function openChat(id: string) {
    if (id === selectedRef.current) return;
    selectedRef.current = id;
    setSelected(id);
    setInput("");
    setSendNote(null);
  }

  async function create() {
    if (creating) return;
    setCreating(true);
    try {
      const res = await fetch(API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(lang === AUTO ? {} : { language: lang }) });
      if (res.status === 401) return toLogin();
      if (!res.ok) throw new Error(await refusal(res));
      const c = (await res.json()) as Row;
      setCreateError(null);
      openChat(c.id);
      setListVersion((v) => v + 1);
    } catch (err) {
      setCreateError(`New test chat failed: ${reason(err)}`);
    } finally {
      setCreating(false);
    }
  }

  async function send() {
    const id = selected;
    const content = input.trim();
    if (!id || !content || sending) return;
    setSending(true);
    setInput("");
    setSendNote(null);
    let note: SendNote | null = null;
    try {
      const res = await fetch(`${API}/${id}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content }) });
      if (res.status === 401) return toLogin();
      if (!res.ok) throw new Error(await refusal(res));
      const answer = (await res.json().catch(() => null)) as { status?: unknown } | null;
      // Stored but not queued: the worker's sweep picks the message up instead of an immediate turn.
      if (answer?.status === "stored") note = { tone: "warn", text: "Stored; reply may take up to a minute" };
      setListVersion((v) => v + 1);
    } catch (err) {
      note = { tone: "error", text: `Not sent: ${reason(err)}` };
      // Give the text back unless something new was typed meanwhile.
      if (selectedRef.current === id) setInput((current) => current || content);
    } finally {
      setSending(false);
    }
    if (selectedRef.current === id) setSendNote(note);
  }

  return (
    <div className="flex h-screen bg-[#0f0f0f] text-white">
      <aside className="flex w-[280px] flex-col border-r border-white/10 bg-[#141414]">
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
          <div><div className="text-sm font-medium">Test chat</div><div className="text-[11px] text-white/50">Direct to the worker, no WhatsApp</div></div>
          <Link href="/admin" className="text-xs text-white/50 hover:text-white">Admin</Link>
        </div>
        <div className="flex gap-2 border-b border-white/10 px-4 py-2">
          <select value={lang} onChange={(e) => setLang(e.target.value as LanguageChoice)} className="min-w-0 flex-1 rounded border border-white/10 bg-[#0f0f0f] px-2 py-1 text-xs">
            <option value={AUTO}>Auto-detect (as on WhatsApp)</option>
            {(Object.keys(LANGS) as Language[]).map((code) => <option key={code} value={code}>{LANGS[code]}</option>)}
          </select>
          <button onClick={create} disabled={creating} className="rounded bg-emerald-500 px-3 py-1 text-xs font-medium text-black disabled:opacity-30">+ New</button>
        </div>
        {list.error && <div role="alert" title={list.error.reason} className="border-b border-white/10 px-4 py-2 text-[11px] text-red-400">{staleMessage(list.lastOkAt, list.error.at)}</div>}
        {createError && <div role="alert" className="border-b border-white/10 px-4 py-2 text-[11px] text-red-400">{createError}</div>}
        <div className="flex-1 overflow-y-auto">
          {(list.data ?? []).map((r) => (
            <button key={r.id} onClick={() => openChat(r.id)} className={`block w-full border-b border-white/5 px-4 py-3 text-left ${selected === r.id ? "bg-white/[0.06]" : "hover:bg-white/[0.03]"}`}>
              <div className="flex justify-between text-xs"><span>{r.phone.replace("+91TEST_", "test-")}</span><span className="text-white/40">{r.language ? r.language.toUpperCase() : "AUTO"}</span></div>
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
            <div className="min-h-0 flex-1"><Transcript id={selected} apiBase={API} pollMs={1500} backHref="/test-chat" /></div>
            {sendNote && (
              <div role={sendNote.tone === "error" ? "alert" : "status"} className={`border-t border-white/10 px-6 py-2 text-xs ${sendNote.tone === "error" ? "text-red-400" : "text-amber-300"}`}>{sendNote.text}</div>
            )}
            <footer className="flex gap-2 border-t border-white/10 px-6 py-3">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  // The Enter that ends an IME composition (Hindi, Marathi and Gujarati phonetic keyboards) must not send;
                  // some browsers mark it only with keyCode 229.
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) { e.preventDefault(); send(); }
                }}
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
