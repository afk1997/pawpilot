import type { Conversation, Message, Turn } from "../db/schema";
import { getConfig } from "../config";
import { detectLanguage } from "../lang";
import { loadActiveAmbulances } from "../directory/repo";
import { matchAmbulances } from "../directory/matcher";
import { buildAmbulanceCard, buildHelplineCard, buildMultiAmbulanceCard } from "../messages/cards";
import { fallbackFoundIntro, fallbackNoMatch } from "../messages/system-replies";
import { deliverText } from "./deliver";
import { createTurn, finishTurn, markAnswered, updateConversation } from "./persist";
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
  // With no model to confirm the place, only an exact area or city match earns a
  // unit's number; substring/token/fuzzy/neighbour hits are guesses and get the helpline.
  const exactPlace = match.match === "area" || match.match === "city";
  let reply: string;
  if (exactPlace && match.candidates.length === 1) {
    reply = `${fallbackFoundIntro(lang)}\n\n${buildAmbulanceCard(match.candidates[0], lang)}`;
  } else if (exactPlace && match.candidates.length >= 2 && match.candidates.length <= 3) {
    reply = `${fallbackFoundIntro(lang, match.candidates.length)}\n\n${buildMultiAmbulanceCard(match.candidates, lang)}`;
  } else {
    reply = `${fallbackNoMatch(lang)}\n${buildHelplineCard(getConfig().helplinePhone, lang)}`;
  }

  const message = await deliverText(conversation, { text: reply, origin: "fallback", turnId: turn.id });
  await markAnswered(pending.map((m) => m.id), turn.id);
  await finishTurn(turn.id, {
    error: reason,
    structuredOutput: { matched: match.candidates.length, matchType: match.match },
    latencyMs: 0,
  });
  await updateConversation(conversation.id, {
    language: lang,
    flagged: true,
    flagReason: conversation.flagged ? conversation.flagReason : "claude_unavailable",
  });
  await recordEvent("fallback_turn", { reason, matched: match.candidates.length }, conversation.id);
  return { turn: { ...turn, error: reason }, message };
}
