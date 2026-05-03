"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

type Language = "en" | "hi" | "mr" | "gu";

// Module-level singleton — avoids the "Multiple GoTrueClient instances"
// warning that fires when the client is re-created across renders/HMR.
const supabaseClient: SupabaseClient | null =
  typeof window !== "undefined" &&
  process.env.NEXT_PUBLIC_SUPABASE_URL &&
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    ? createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
      )
    : null;

interface TestConversation {
  id: string;
  phone: string;
  language: Language | null;
  status: string;
  created_at: string;
  updated_at: string;
  last_message: string | null;
  last_message_role: "user" | "assistant" | null;
  is_test: boolean;
}

interface Message {
  id: string;
  conversation_id: string;
  role: "user" | "assistant";
  content: string;
  message_type: string;
  delivery_status: string | null;
  created_at: string;
}

const LANGS: Array<{ code: Language; label: string }> = [
  { code: "en", label: "English" },
  { code: "hi", label: "Hindi" },
  { code: "mr", label: "Marathi" },
  { code: "gu", label: "Gujarati" },
];

export function TestChatClient() {
  const supabase = supabaseClient;

  const [conversations, setConversations] = useState<TestConversation[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [showNewChat, setShowNewChat] = useState(false);
  const [newChatLang, setNewChatLang] = useState<Language>("en");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const selected = conversations.find((c) => c.id === selectedId);

  const fetchConversations = useCallback(async () => {
    const res = await fetch("/api/test-chat/conversations");
    if (!res.ok) return;
    const data = await res.json();
    setConversations(data);
  }, []);

  const fetchMessages = useCallback(async (convoId: string) => {
    const res = await fetch(`/api/test-chat/conversations/${convoId}/messages`);
    if (!res.ok) {
      setMessages([]);
      return;
    }
    const data = await res.json();
    setMessages(data);
  }, []);

  useEffect(() => {
    let active = true;
    void (async () => {
      const res = await fetch("/api/test-chat/conversations");
      if (!res.ok) return;
      const data = await res.json();
      if (active) setConversations(data);
    })();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    if (!selectedId) {
      void Promise.resolve().then(() => {
        if (active) setMessages([]);
      });
      return () => {
        active = false;
      };
    }
    void (async () => {
      const res = await fetch(`/api/test-chat/conversations/${selectedId}/messages`);
      if (!res.ok) {
        if (active) setMessages([]);
        return;
      }
      const data = await res.json();
      if (active) setMessages(data);
    })();
    return () => {
      active = false;
    };
  }, [selectedId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Realtime: subscribe once. New assistant messages for the selected
  // conversation get appended; conversation-list refreshes on any change.
  useEffect(() => {
    if (!supabase) return;
    const channel = supabase
      .channel("test-chat-realtime")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "messages" },
        (payload) => {
          const m = payload.new as Message;
          // Only react to messages for the selected test conversation.
          if (m.conversation_id !== selectedId) {
            // Refresh the list so latest-message preview updates.
            fetchConversations();
            return;
          }
          setMessages((prev) => {
            if (prev.some((x) => x.id === m.id)) return prev;
            return [...prev, m];
          });
          fetchConversations();
        }
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "conversations" },
        (payload) => {
          const row = (payload.new ?? payload.old) as { is_test?: boolean } | null;
          // Only refresh on test-conversation events.
          if (row?.is_test) fetchConversations();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [selectedId, fetchConversations, supabase]);

  // Polling fallback. Realtime should deliver assistant messages within ~50ms
  // of insert, but: (a) Supabase Realtime publication might not include the
  // messages table, (b) RLS or auth state can silently filter broadcasts.
  // 2-second poll catches up regardless. Cheap on a local dev DB.
  useEffect(() => {
    if (!selectedId) return;
    const interval = setInterval(() => {
      fetchMessages(selectedId);
      fetchConversations();
    }, 2000);
    return () => clearInterval(interval);
  }, [selectedId, fetchMessages, fetchConversations]);

  async function createChat() {
    const res = await fetch("/api/test-chat/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ language: newChatLang }),
    });
    if (!res.ok) return;
    const created = (await res.json()) as TestConversation;
    setShowNewChat(false);
    await fetchConversations();
    setSelectedId(created.id);
  }

  async function sendMessage() {
    if (!input.trim() || !selectedId || sending) return;
    setSending(true);
    const content = input.trim();
    setInput("");
    try {
      await fetch(`/api/test-chat/conversations/${selectedId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      // Optimistically refetch — Realtime will fill in the assistant reply.
      await fetchMessages(selectedId);
    } finally {
      setSending(false);
    }
  }

  function handleComposerKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  function formatTime(d: string) {
    return new Date(d).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function shortLabel(c: TestConversation) {
    return c.phone.replace("+91TEST_", "test-");
  }

  return (
    <div className="flex h-screen bg-[#0f0f0f] font-sans text-white">
      {/* Sidebar */}
      <aside
        className="w-[300px] flex flex-col border-r border-white/[0.06]"
        style={{ background: "#141414" }}
      >
        <div className="px-4 py-3 border-b border-white/[0.06] flex items-center justify-between">
          <div>
            <div className="text-sm font-medium">Test chat</div>
            <div className="text-[11px] text-white/50">
              Direct AI — no Interakt
            </div>
          </div>
          <button
            onClick={() => setShowNewChat(true)}
            className="text-xs px-3 py-1.5 rounded-md bg-emerald-500 hover:bg-emerald-400 text-black font-medium"
          >
            + New
          </button>
        </div>

        {showNewChat && (
          <div className="px-4 py-3 border-b border-white/[0.06] bg-white/[0.02]">
            <label className="text-[11px] text-white/60 block mb-2">Language</label>
            <select
              value={newChatLang}
              onChange={(e) => setNewChatLang(e.target.value as Language)}
              className="w-full bg-[#0f0f0f] border border-white/10 rounded px-2 py-1.5 text-xs mb-2"
            >
              {LANGS.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label}
                </option>
              ))}
            </select>
            <div className="flex gap-2">
              <button
                onClick={createChat}
                className="flex-1 text-xs px-3 py-1.5 rounded-md bg-emerald-500 hover:bg-emerald-400 text-black font-medium"
              >
                Create
              </button>
              <button
                onClick={() => setShowNewChat(false)}
                className="text-xs px-3 py-1.5 rounded-md bg-white/5 hover:bg-white/10"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        <div className="flex-1 overflow-y-auto">
          {conversations.length === 0 && (
            <div className="text-xs text-white/40 px-4 py-6 text-center">
              No test chats yet. Click + New to start one.
            </div>
          )}
          {conversations.map((c) => (
            <button
              key={c.id}
              onClick={() => setSelectedId(c.id)}
              className={`w-full text-left px-4 py-3 border-b border-white/[0.04] transition-colors ${
                selectedId === c.id
                  ? "bg-white/[0.05]"
                  : "hover:bg-white/[0.03]"
              }`}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-xs font-medium truncate">
                  {shortLabel(c)}
                </span>
                <span className="text-[10px] text-white/40 shrink-0">
                  {(c.language ?? "en").toUpperCase()}
                </span>
              </div>
              {c.last_message && (
                <div className="text-[11px] text-white/50 truncate mt-1">
                  {c.last_message_role === "assistant" ? "↪ " : ""}
                  {c.last_message}
                </div>
              )}
              <div className="text-[10px] text-white/30 mt-1">
                {formatTime(c.updated_at)}
              </div>
            </button>
          ))}
        </div>
      </aside>

      {/* Main chat pane */}
      <main className="flex-1 flex flex-col">
        {!selected && (
          <div className="flex-1 flex items-center justify-center text-white/40 text-sm">
            Select or create a test chat to begin.
          </div>
        )}
        {selected && (
          <>
            <header className="px-6 py-3 border-b border-white/[0.06] flex items-center justify-between">
              <div>
                <div className="text-sm font-medium">{shortLabel(selected)}</div>
                <div className="text-[11px] text-white/40">
                  {selected.status} · {selected.language ?? "en"} · {messages.length} messages
                </div>
              </div>
            </header>

            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3">
              {messages.length === 0 && (
                <div className="text-xs text-white/40 text-center py-12">
                  No messages yet. Send one to wake up the agent.
                </div>
              )}
              {messages.map((m) => (
                <MessageBubble key={m.id} message={m} formatTime={formatTime} />
              ))}
              <div ref={messagesEndRef} />
            </div>

            <footer className="px-6 py-3 border-t border-white/[0.06]">
              <div className="flex gap-2">
                <textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleComposerKey}
                  placeholder="Type a message… (Enter to send, Shift+Enter newline)"
                  rows={2}
                  className="flex-1 bg-[#141414] border border-white/10 rounded-md px-3 py-2 text-sm resize-none focus:outline-none focus:border-emerald-500/40"
                  disabled={sending}
                />
                <button
                  onClick={sendMessage}
                  disabled={!input.trim() || sending}
                  className="px-4 rounded-md bg-emerald-500 hover:bg-emerald-400 text-black text-sm font-medium disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  {sending ? "…" : "Send"}
                </button>
              </div>
            </footer>
          </>
        )}
      </main>
    </div>
  );
}

function MessageBubble({
  message,
  formatTime,
}: {
  message: Message;
  formatTime: (d: string) => string;
}) {
  const isUser = message.role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[640px] rounded-lg px-3 py-2 ${
          isUser
            ? "bg-emerald-500 text-black"
            : "bg-[#1c1c1c] border border-white/[0.06] text-white"
        }`}
      >
        <div className="text-[13px] whitespace-pre-wrap break-words">{message.content}</div>
        <div
          className={`text-[10px] mt-1 ${
            isUser ? "text-black/50" : "text-white/30"
          }`}
        >
          {formatTime(message.created_at)}
          {!isUser && message.delivery_status === "test_skipped" && (
            <span className="ml-2">· test_skipped</span>
          )}
        </div>
      </div>
    </div>
  );
}
