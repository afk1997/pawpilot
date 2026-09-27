import type { Conversation, Message, Turn } from "../db/schema";
import { getConfig } from "../config";
import { detectLanguage, isGreetingOnly } from "../lang";
import { log } from "../log";
import { loadActiveAmbulances } from "../directory/repo";
import { matchAmbulances } from "../directory/matcher";
import { buildAmbulanceCard, buildHelplineCard, buildMultiAmbulanceCard } from "../messages/cards";
import { fallbackFoundIntro, fallbackNoMatch } from "../messages/system-replies";
import { deliverText } from "./deliver";
import { createTurn, finishTurn, flagConversation, updateConversation } from "./persist";
import { recordEvent } from "../inbound/store";
import type { Language } from "../types";

/** Text the matcher sees: message bodies plus resolved place labels for pins. */
export function pendingText(pending: Message[]): string {
  return pending
    .map((m) => (m.kind === "location" ? m.placeLabel ?? "" : m.content))
    .filter((t) => t && t.trim().length > 0)
    .join(" ");
}

/**
 * Pure-code answer used whenever Claude is paused or failed. Never asks a
 * question, never promises a callback; always ends with a real number.
 */
export async function runFallbackTurn(input: { conversation: Conversation; pending: Message[]; reason: string }): Promise<{ turn: Turn; message: Message }> {
  const { conversation, pending, reason } = input;
  const text = pendingText(pending);
  const lang: Language = conversation.language ?? detectLanguage(text);
  const turn = await createTurn({ conversationId: conversation.id, status: "fallback", model: "fallback" });

  const rows = await loadActiveAmbulances();
  const match = matchAmbulances(rows, { query: text });
  const matched = match.candidates.length;
  // With no model to confirm the place, only an exact area or city match earns a
  // unit's number; substring/token/fuzzy/neighbour hits are guesses and get the helpline.
  const exactPlace = match.match === "area" || match.match === "city";
  let sent: "unit" | "units" | "helpline";
  let reply: string;
  if (exactPlace && matched === 1) {
    sent = "unit";
    reply = `${fallbackFoundIntro(lang)}\n\n${buildAmbulanceCard(match.candidates[0], lang)}`;
  } else if (exactPlace && matched >= 2 && matched <= 3) {
    sent = "units";
    reply = `${fallbackFoundIntro(lang, matched)}\n\n${buildMultiAmbulanceCard(match.candidates, lang)}`;
  } else {
    sent = "helpline";
    const card = buildHelplineCard(getConfig().helplinePhone, lang);
    // An exact place with more units than a card lists was found, so "couldn't find that area" would be
    // wrong: send the card alone (its first line already asks the reporter to call the helpline).
    reply = exactPlace && matched > 3 ? card : `${fallbackNoMatch(lang)}\n${card}`;
  }

  // The burst is marked answered with the reply, before the send (deliverText's write-ahead).
  const message = await deliverText(conversation, { text: reply, origin: "fallback", turnId: turn.id, answers: pending.map((m) => m.id) });
  const finish = { error: reason, structuredOutput: { matched, matchType: match.match, sent }, latencyMs: 0 };
  await finishTurn(turn.id, finish);
  // A burst with no real content (a greeting, a sticker, a caption-less photo) detects as English only by default,
  // so it does not decide the language; the first message with real content does.
  if (conversation.language == null && !isGreetingOnly(text)) await updateConversation(conversation.id, { language: lang });
  await flagConversation(conversation.id, "claude_unavailable");
  // Best effort: the reply and the turn are already recorded, so a failing events insert must not fail the turn.
  try {
    await recordEvent(
      "fallback_turn",
      { reason, turnId: turn.id, matched, matchType: match.match, sent, deliveryStatus: message.deliveryStatus },
      conversation.id
    );
  } catch {
    log.warn({ conversationId: conversation.id }, "fallback_turn event not recorded");
  }
  return { turn: { ...turn, ...finish }, message };
}
