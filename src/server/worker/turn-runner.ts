import { openLockConnection } from "../db/client";
import type { Message } from "../db/schema";
import { detectLanguage } from "../lang";
import { audioNotSupported } from "../messages/system-replies";
import { enqueueTurn } from "../queue/boss";
import { log } from "../log";
import { gatherPending } from "./gather";
import { claimWelcome, classifyPending, sendMenu, sendWelcome } from "./first-contact";
import { pendingText } from "./fallback";
import { deliverText } from "./deliver";
import { createTurn, finishTurn, updateConversation } from "./persist";
import { runClaudeTurn } from "./claude-turn";
import type { LLMBackend } from "../agent/types";
import type { Language } from "../types";

export interface TurnDeps {
  /** The LLM backend; getBackend() when absent. */
  backend?: LLMBackend;
  /** The clock for the pause check, the prompt's time and the transcript; the system clock when absent. */
  now?: () => Date;
  /** A monotonic clock in milliseconds for the Claude turn's time budget; performance.now() when absent. */
  nowMs?: () => number;
}

export type TurnOutcome = {
  kind: "noop" | "locked" | "human_mode" | "welcome" | "menu" | "audio_only" | "fallback" | "ok" | "failed";
  turnId?: string;
  requeued?: boolean;
};

/**
 * Session-level advisory lock on a connection opened for this turn alone and closed after it. If that
 * connection's backend dies mid-turn, the lock dies with it and the unlock reconnects instead of crashing.
 */
async function withConversationLock<T>(conversationId: string, fn: () => Promise<T>): Promise<T | "locked"> {
  const lockConn = openLockConnection();
  try {
    const [{ locked }] = await lockConn<{ locked: boolean }[]>`select pg_try_advisory_lock(hashtext(${conversationId})::bigint) as locked`;
    if (!locked) return "locked";
    try {
      return await fn();
    } finally {
      // Never mask fn's result or error.
      try {
        const [{ unlocked }] = await lockConn<{ unlocked: boolean }[]>`select pg_advisory_unlock(hashtext(${conversationId})::bigint) as unlocked`;
        // false: the lock's backend died mid-turn, taking the lock with it, and this ran on a new session.
        if (!unlocked) log.warn({ conversationId }, "advisory lock lost mid-turn");
      } catch {
        log.warn({ conversationId }, "advisory unlock failed");
      }
    }
  } finally {
    try {
      await lockConn.end({ timeout: 5 });
    } catch {
      log.warn({ conversationId }, "lock connection close failed");
    }
  }
}

export async function runTurn(conversationId: string, deps: TurnDeps = {}): Promise<TurnOutcome> {
  const result = await withConversationLock(conversationId, () => runTurnLocked(conversationId, deps));
  if (result === "locked") {
    await enqueueTurn(conversationId);
    return { kind: "locked", requeued: true };
  }
  return result;
}

async function requeueIfPending(conversationId: string): Promise<boolean> {
  const again = await gatherPending(conversationId);
  if (again && again.pending.length > 0 && again.conversation.mode === "agent") {
    await enqueueTurn(conversationId, { immediate: true });
    return true;
  }
  return false;
}

/**
 * A reply sent without the model (welcome, menu, voice-note line). Its turn is created first, so the message carries
 * the turn's id, and stays "failed" until the send returns: a reply that was not delivered leaves it "failed" with
 * error "delivery_failed". Returns the turn's id.
 */
async function systemTurn(conversationId: string, model: string, send: (turnId: string) => Promise<Message>): Promise<string> {
  const turn = await createTurn({ conversationId, status: "failed", model });
  const message = await send(turn.id);
  await finishTurn(turn.id, message.deliveryStatus === "failed" ? { error: "delivery_failed" } : { status: "ok" });
  return turn.id;
}

async function runTurnLocked(conversationId: string, deps: TurnDeps): Promise<TurnOutcome> {
  const gathered = await gatherPending(conversationId);
  if (!gathered || gathered.pending.length === 0) return { kind: "noop" };
  let { conversation } = gathered;
  const { pending } = gathered;
  if (conversation.mode === "human") return { kind: "human_mode" };

  const text = pendingText(pending);
  const lang: Language = conversation.language ?? detectLanguage(text);
  const cls = classifyPending(pending);
  // Every reply below marks the burst answered with itself, before its send (deliver.ts's write-ahead).
  const pendingIds = pending.map((m) => m.id);
  let welcomeJustSent = false;

  if (await claimWelcome(conversation.id)) {
    // The welcome answers the burst only when the burst was nothing but greetings; otherwise the reply below does.
    const welcomeTurnId = await systemTurn(conversation.id, "system:welcome", (id) =>
      sendWelcome(conversation, lang, id, cls.allGreeting ? pendingIds : [])
    );
    // A burst with no real content ("hi", a sticker, a voice note) detects as English only by default,
    // so it does not decide the language; the first message with real content does.
    if (!(cls.allGreeting || cls.allAudio) || lang !== "en") {
      await updateConversation(conversation.id, { language: lang });
      conversation = { ...conversation, language: lang };
    }
    conversation = { ...conversation, welcomedAt: new Date() };
    welcomeJustSent = true;
    if (cls.allGreeting) return { kind: "welcome", turnId: welcomeTurnId, requeued: await requeueIfPending(conversation.id) };
  }

  if (cls.allMenu) {
    const turnId = await systemTurn(conversation.id, "system:menu", (id) => sendMenu(conversation, lang, id, pendingIds));
    return { kind: "menu", turnId, requeued: await requeueIfPending(conversation.id) };
  }

  if (cls.allAudio) {
    const turnId = await systemTurn(conversation.id, "system:audio", (id) =>
      deliverText(conversation, { text: audioNotSupported(lang), origin: "system", turnId: id, answers: pendingIds })
    );
    return { kind: "audio_only", turnId, requeued: await requeueIfPending(conversation.id) };
  }

  // Everything else goes to Claude, a bare greeting after the welcome included: the prompt answers it with one warm
  // line, never the menu again.
  const now = deps.now ?? (() => new Date());
  const nowMs = deps.nowMs ?? (() => performance.now());
  const r = await runClaudeTurn({ conversation, pending, lang, welcomeJustSent, backend: deps.backend, now, nowMs });
  return { kind: r.outcome, turnId: r.turnId, requeued: await requeueIfPending(conversation.id) };
}
