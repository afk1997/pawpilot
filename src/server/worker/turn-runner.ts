import { openLockConnection } from "../db/client";
import type { Message } from "../db/schema";
import { detectLanguage } from "../lang";
import { audioNotSupported } from "../messages/system-replies";
import { enqueueTurn } from "../queue/boss";
import { log } from "../log";
import { gatherPending } from "./gather";
import { claimWelcome, classifyPending, sendMenu, sendWelcome } from "./first-contact";
import { runFallbackTurn, pendingText } from "./fallback";
import { deliverText } from "./deliver";
import { createTurn, finishTurn, markAnswered, updateConversation } from "./persist";
import type { Language } from "../types";

export interface TurnDeps {
  backend?: unknown; // replaced by LLMBackend in Task 21
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

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- deps carries the LLM backend once Task 21 adds the Claude branch
export async function runTurn(conversationId: string, _deps: TurnDeps = {}): Promise<TurnOutcome> {
  const result = await withConversationLock(conversationId, () => runTurnLocked(conversationId));
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

async function runTurnLocked(conversationId: string): Promise<TurnOutcome> {
  const gathered = await gatherPending(conversationId);
  if (!gathered || gathered.pending.length === 0) return { kind: "noop" };
  let { conversation } = gathered;
  const { pending } = gathered;
  if (conversation.mode === "human") return { kind: "human_mode" };

  const text = pendingText(pending);
  const lang: Language = conversation.language ?? detectLanguage(text);
  const cls = classifyPending(pending);
  let welcomeJustSent = false;

  if (await claimWelcome(conversation.id)) {
    const welcomeTurnId = await systemTurn(conversation.id, "system:welcome", (id) => sendWelcome(conversation, lang, id));
    // A burst with no real content ("hi", a sticker, a voice note) detects as English only by default,
    // so it does not decide the language; the first message with real content does.
    if (!(cls.allGreeting || cls.allAudio) || lang !== "en") {
      await updateConversation(conversation.id, { language: lang });
      conversation = { ...conversation, language: lang };
    }
    conversation = { ...conversation, welcomedAt: new Date() };
    welcomeJustSent = true;
    if (cls.allGreeting) {
      await markAnswered(pending.map((m) => m.id), welcomeTurnId);
      return { kind: "welcome", turnId: welcomeTurnId, requeued: await requeueIfPending(conversation.id) };
    }
  }

  if (cls.allMenu) {
    const turnId = await systemTurn(conversation.id, "system:menu", (id) => sendMenu(conversation, lang, id));
    await markAnswered(pending.map((m) => m.id), turnId);
    return { kind: "menu", turnId, requeued: await requeueIfPending(conversation.id) };
  }

  if (cls.allAudio) {
    const turnId = await systemTurn(conversation.id, "system:audio", (id) =>
      deliverText(conversation, { text: audioNotSupported(lang), origin: "system", turnId: id })
    );
    await markAnswered(pending.map((m) => m.id), turnId);
    return { kind: "audio_only", turnId, requeued: await requeueIfPending(conversation.id) };
  }

  if (cls.allGreeting && !welcomeJustSent) {
    // Already welcomed; a bare greeting later gets a short line from Claude in Task 21. Until then, the menu.
    const turnId = await systemTurn(conversation.id, "system:menu", (id) => sendMenu(conversation, lang, id));
    await markAnswered(pending.map((m) => m.id), turnId);
    return { kind: "menu", turnId, requeued: await requeueIfPending(conversation.id) };
  }

  log.info({ conversationId, welcomeJustSent }, "running fallback turn (no backend yet)");
  const r = await runFallbackTurn({ conversation, pending, reason: "no_backend" });
  return { kind: "fallback", turnId: r.turn.id, requeued: await requeueIfPending(conversation.id) };
}
