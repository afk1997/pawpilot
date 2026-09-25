import { getSql } from "../db/client";
import { detectLanguage } from "../lang";
import { audioNotSupported } from "../messages/system-replies";
import { enqueueTurn } from "../queue/boss";
import { log } from "../log";
import { gatherPending } from "./gather";
import { claimWelcome, classifyPending, sendMenu, sendWelcome } from "./first-contact";
import { runFallbackTurn, pendingText } from "./fallback";
import { deliverText } from "./deliver";
import { createTurn, markAnswered, updateConversation } from "./persist";
import type { Language } from "../types";

export interface TurnDeps {
  backend?: unknown; // replaced by LLMBackend in Task 21
}

export type TurnOutcome = {
  kind: "noop" | "locked" | "human_mode" | "welcome" | "menu" | "audio_only" | "fallback" | "ok" | "failed";
  turnId?: string;
  requeued?: boolean;
};

/** Session-level advisory lock on a reserved connection; released in `finally`. */
async function withConversationLock<T>(conversationId: string, fn: () => Promise<T>): Promise<T | "locked"> {
  const reserved = await getSql().reserve();
  try {
    const [{ locked }] = await reserved<{ locked: boolean }[]>`select pg_try_advisory_lock(hashtext(${conversationId})::bigint) as locked`;
    if (!locked) return "locked";
    try {
      return await fn();
    } finally {
      await reserved`select pg_advisory_unlock(hashtext(${conversationId})::bigint)`;
    }
  } finally {
    reserved.release();
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
    await sendWelcome(conversation, lang);
    await updateConversation(conversation.id, { language: lang });
    conversation = { ...conversation, language: lang, welcomedAt: new Date() };
    welcomeJustSent = true;
    if (cls.allGreeting) {
      const turn = await createTurn({ conversationId: conversation.id, status: "ok", model: "system:welcome" });
      await markAnswered(pending.map((m) => m.id), turn.id);
      return { kind: "welcome", turnId: turn.id, requeued: await requeueIfPending(conversation.id) };
    }
  }

  if (cls.allMenu) {
    await sendMenu(conversation, lang);
    const turn = await createTurn({ conversationId: conversation.id, status: "ok", model: "system:menu" });
    await markAnswered(pending.map((m) => m.id), turn.id);
    return { kind: "menu", turnId: turn.id, requeued: await requeueIfPending(conversation.id) };
  }

  if (cls.allAudio) {
    const turn = await createTurn({ conversationId: conversation.id, status: "ok", model: "system:audio" });
    await deliverText(conversation, { text: audioNotSupported(lang), origin: "system", turnId: turn.id });
    await markAnswered(pending.map((m) => m.id), turn.id);
    return { kind: "audio_only", turnId: turn.id, requeued: await requeueIfPending(conversation.id) };
  }

  if (cls.allGreeting && !welcomeJustSent) {
    // Already welcomed; a bare greeting later gets a short line from Claude in Task 21. Until then, the menu.
    await sendMenu(conversation, lang);
    const turn = await createTurn({ conversationId: conversation.id, status: "ok", model: "system:menu" });
    await markAnswered(pending.map((m) => m.id), turn.id);
    return { kind: "menu", turnId: turn.id, requeued: await requeueIfPending(conversation.id) };
  }

  log.info({ conversationId, welcomeJustSent }, "running fallback turn (no backend yet)");
  const r = await runFallbackTurn({ conversation, pending, reason: "no_backend" });
  return { kind: "fallback", turnId: r.turn.id, requeued: await requeueIfPending(conversation.id) };
}
