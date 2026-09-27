import { and, eq, inArray, or } from "drizzle-orm";
import { getDb } from "../db/client";
import { messages, turns, type Conversation, type Message } from "../db/schema";
import { HandleRegistry } from "../agent/handles";
import { maskDigitRuns } from "../agent/scrub";
import { loadActiveAmbulances } from "../directory/repo";
import { areaNamesIn, citiesNamed, matchAmbulances, normalize, type DirectoryAmbulance } from "../directory/matcher";
import { buildAmbulanceCard, buildAmbulanceCardTemplate } from "../messages/cards";
import { fallbackFoundIntro, firstContactGreeting } from "../messages/system-replies";
import { recordEvent } from "../inbound/store";
import { isGreetingOnly } from "../lang";
import { log, safeErrorFields } from "../log";
import type { Language } from "../types";
import { pendingText } from "./fallback";
import { deliverText } from "./deliver";
import { createTurn, finishTurn, updateConversation } from "./persist";

/** The model name on a fast-path turn's row: how a later burst knows the conversation was answered. */
export const FAST_PATH_MODEL = "fast_path";

/** A longer burst says more than where the animal is, so the model reads it. */
export const FAST_PATH_MAX_CHARS = 300;

/**
 * Words that say the reporter wants something besides a new ambulance number (a clinic, to donate or volunteer, a
 * person, a complaint, a wrong number, a driver who does not answer, help for a hurt human): a burst holding one goes to
 * the model even when it names a place. The one list, in Latin script (English and Hinglish), Devanagari (Hindi and
 * Marathi) and Gujarati, the bot's own menu words included. A Latin word here must start no covered place's name:
 * "band" would block Bandra, and "man" and "accident" are left out as too broad.
 */
export const OTHER_INTENT_WORDS = [
  "clinic", "clinik", "hospital", "doctor", "dawakhana", "क्लिनिक", "दवाखाना", "अस्पताल", "डॉक्टर", "દવાખાન", "હોસ્પિટલ",
  "donate", "donation", "daan", "दान", "દાન", "volunteer", "स्वयंसेवक", "સ્વયંસેવક",
  "human", "insaan", "इंसान", "person", "talk", "baat", "complaint", "shikayat", "शिकायत", "ફરિયાદ",
  "wrong", "galat", "गलत", "ખોટ",
  // A driver who does not answer: the model gives another unit and the helpline (the prompt's rule 8).
  "utha", "uthaya", "uthata", "uthate", "uthaate", "switched", "unreachable", "reachable", "answering",
  "उठा", "उठाया", "उठाता", "बंद", "ઉપાડ", "બંધ",
  // A hurt person: the model relays the emergency numbers.
  "aadmi", "admi", "vyakti", "आदमी", "व्यक्ति", "माणूस", "વ્યક્તિ", "માણસ",
  // The menu's own words (welcome.ts) and Marathi-only words: a complaint, a donation.
  "वालंटियर", "वॉलंटियर", "ક્લિનિક", "तक्रार", "देणगी",
] as const;

/**
 * A listed word at the start of a word, in any case, whatever ending follows: "Clinics", "दवाखाना", "દવાખાનું" and
 * "ખોટો" count; "vardaan" and "वरदान" do not.
 */
const OTHER_INTENT_RE = new RegExp(`(?<![\\p{L}\\p{M}\\p{N}])(?:${OTHER_INTENT_WORDS.join("|")})`, "iu");
/** Devanagari and Gujarati nukta: "ग़लत" is read as "गलत". */
const NUKTA_RE = /[़઼]/g;

export function hasOtherIntentWord(text: string): boolean {
  return OTHER_INTENT_RE.test(text.normalize("NFC").replace(NUKTA_RE, ""));
}

/**
 * Locality words so common that an area name holding one ("Model Town", "Vijay Nagar", "Mira Road") names a place in
 * many cities: an area match that goes only through such names takes the fast path only when the text also names the
 * unit's city. A whole word of the area name, in any case. The directory's area names are all in Latin script (the
 * seed fixture's and ambulances-clinics.csv's alike), so the list is too; an Indic area name added to the directory
 * needs its locality words here.
 */
export const GENERIC_AREA_WORDS = [
  "nagar", "town", "colony", "road", "park", "garden", "vihar", "puram", "gunj", "ganj", "chowk", "market", "marg", "gali",
  "society", "sector", "phase", "block", "layout", "extension", "enclave", "camp", "lines", "bazaar", "bazar", "basti",
  "model", "new", "old", "east", "west", "north", "south", "central",
] as const;

const GENERIC_AREA_SET: ReadonlySet<string> = new Set(GENERIC_AREA_WORDS);

/** Whether an area name holds a word of GENERIC_AREA_WORDS, as a whole word after normalize. */
export function hasGenericAreaWord(areaName: string): boolean {
  return normalize(areaName).split(" ").some((w) => GENERIC_AREA_SET.has(w));
}

export type PlaceDecision =
  | { fire: true; unit: DirectoryAmbulance; matchType: "area" | "city" }
  | { fire: false; reason: "no_single_match" | "other_city" | "generic_area" };

export type FastPathDecision =
  | Extract<PlaceDecision, { fire: true }>
  | { fire: false; reason: "burst" | "too_long" | "other_intent" | "answered_before" | "no_single_match" | "other_city" | "generic_area" | "error" };

/**
 * The fast path's place checks, pure (rows in, decision out). The text alone must match exactly one unit by area or
 * city (the fallback's rule for an exact place); it must name no directory city but that unit's (citiesNamed: "Ghatkopar,
 * Pune" is other_city); and an area match fires only through an area name of the unit with no GENERIC_AREA_WORDS word,
 * or when the text names the unit's city ("Karve Nagar, Pune" fires, "Model Town, Ludhiana" is generic_area). A text
 * naming both a plain and a generic name of the unit ("Andheri West") fires on the plain one.
 */
export function placeDecision(rows: DirectoryAmbulance[], text: string): PlaceDecision {
  const match = matchAmbulances(rows, { query: text });
  const matchType = match.match;
  if ((matchType !== "area" && matchType !== "city") || match.candidates.length !== 1) return { fire: false, reason: "no_single_match" };
  const unit = match.candidates[0];
  const unitCity = normalize(unit.city);
  const cities = citiesNamed(rows, text).map(normalize);
  if (cities.some((c) => c !== unitCity)) return { fire: false, reason: "other_city" };
  if (matchType === "area" && !cities.includes(unitCity) && areaNamesIn(unit, text).every(hasGenericAreaWord)) {
    return { fire: false, reason: "generic_area" };
  }
  return { fire: true, unit, matchType };
}

/** What the fast path reads: text, and location pins that carry a place label. A photo, a voice note or a sticker is the model's. */
const readable = (m: Message) => m.kind === "text" || (m.kind === "location" && !!m.placeLabel?.trim());

/**
 * Whether a reply already answered the reporter: the model's, the fallback's, a person's or a fast path's. The welcome,
 * the menu and the voice-note line do not count, so the first burst with content can still take the fast path.
 */
async function answeredBefore(conversationId: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ id: messages.id })
    .from(messages)
    .leftJoin(turns, eq(turns.id, messages.turnId))
    .where(
      and(
        eq(messages.conversationId, conversationId),
        eq(messages.role, "assistant"),
        or(inArray(messages.origin, ["agent", "fallback", "human"]), eq(turns.model, FAST_PATH_MODEL))
      )
    )
    .limit(1);
  return row !== undefined;
}

/**
 * Whether this burst gets a unit's card without the model: the conversation's first answered burst, only text and
 * labelled pins, at most FAST_PATH_MAX_CHARS, no word of OTHER_INTENT_WORDS, and the reporter's words alone passing
 * placeDecision (exactly one unit by area or city, no other city named, no area match through generic names alone).
 * Cheapest checks first: the directory is loaded (`loadRows`) only for a burst that passed the rest. Never throws: a
 * failed check is logged and recorded as a fast_path_error event (the error's class and code only), and the model
 * answers instead. `reason` says why it did not fire.
 */
export async function fastPathDecision(
  conversation: Conversation,
  pending: Message[],
  loadRows: () => Promise<DirectoryAmbulance[]> = loadActiveAmbulances
): Promise<FastPathDecision> {
  try {
    if (pending.length === 0 || !pending.every(readable)) return { fire: false, reason: "burst" };
    const text = pendingText(pending);
    if (text.length > FAST_PATH_MAX_CHARS) return { fire: false, reason: "too_long" };
    if (hasOtherIntentWord(text)) return { fire: false, reason: "other_intent" };
    if (await answeredBefore(conversation.id)) return { fire: false, reason: "answered_before" };
    return placeDecision(await loadRows(), text);
  } catch (e) {
    const fields = safeErrorFields(e);
    log.warn({ conversationId: conversation.id, ...fields }, "fast path check failed; the model answers");
    try {
      await recordEvent("fast_path_error", fields, conversation.id);
    } catch {
      log.warn({ conversationId: conversation.id }, "fast_path_error event not recorded");
    }
    return { fire: false, reason: "error" };
  }
}

/**
 * The fast path's reply: the fallback's intro and the unit's card, sent as a system reply without the model. The turn is
 * written first, with status ok and its audit (the handle included, so a later turn resolves the token the stored
 * template carries in place of the number), and the burst is marked answered with the reply before the send
 * (deliverText's write-ahead). A card that was not delivered leaves the turn failed with delivery_failed, as on every
 * other turn; the conversation is never flagged for the fast path itself. The language is stored, as the fallback
 * does, when the conversation has none and the burst is more than greetings. On the conversation's first message
 * (`firstContact`), which got no welcome list, the card opens with a one-line greeting. The stored template carries
 * the token for the number and no other phone-shaped run (maskDigitRuns). `startedMs`: when the check began, on the
 * `nowMs` clock, for the turn's latency.
 */
export async function runFastPathTurn(input: {
  conversation: Conversation;
  pending: Message[];
  unit: DirectoryAmbulance;
  matchType: "area" | "city";
  lang: Language;
  /** The conversation's first message: no welcome list went out, so the card greets first. */
  firstContact?: boolean;
  nowMs: () => number;
  startedMs: number;
}): Promise<{ turnId: string }> {
  const { conversation, pending, unit, matchType, lang } = input;
  const registry = new HandleRegistry(conversation.id);
  const token = `{{AMB:${registry.ambulance(unit.id)}}}`;
  const intro = `${input.firstContact ? `${firstContactGreeting(lang)} ` : ""}${fallbackFoundIntro(lang)}`;
  const text = `${intro}\n\n${buildAmbulanceCard(unit, lang)}`;
  // The template feeds the next transcript, which must never show digits: a phone-shaped run in the unit's name, area
  // or city cell (ingest only warns about one) goes in as the transcript's "[number sent]" marker, as the scrubber reads
  // runs. A handle holds no digit, so the token stays whole; the reporter's text is unchanged.
  const template = maskDigitRuns(`${intro}\n\n${buildAmbulanceCardTemplate(unit, lang, token)}`, "[number sent]");
  const turn = await createTurn({
    conversationId: conversation.id,
    status: "ok",
    model: FAST_PATH_MODEL,
    handles: registry.toJSON(),
    structuredOutput: {
      reply: template, language: lang, intent: "ambulance", location: { city: unit.city, area: unit.area }, needs_human: false,
      notes: "fast path: exact single-unit match", matched: 1, matchType, sent: "unit", fastPath: true,
    },
  });
  const message = await deliverText(conversation, { text, template, origin: "system", turnId: turn.id, answers: pending.map((m) => m.id) });
  // From here the card is out: a throw propagates, since answering again would send a second reply.
  const delivered = message.deliveryStatus !== "failed";
  await finishTurn(turn.id, {
    latencyMs: Math.round(input.nowMs() - input.startedMs),
    ...(!delivered && { status: "failed" as const, error: "delivery_failed" }),
  });
  if (conversation.language == null && !isGreetingOnly(pendingText(pending))) await updateConversation(conversation.id, { language: lang });
  // Best effort: the reply and the turn are recorded, so a failing events insert must not fail the turn.
  try {
    await recordEvent("fast_path", { turnId: turn.id, matchType, unitLabel: unit.label }, conversation.id);
  } catch {
    log.warn({ conversationId: conversation.id }, "fast_path event not recorded");
  }
  return { turnId: turn.id };
}
