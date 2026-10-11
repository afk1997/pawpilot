import type { Intent, Language } from "../types";
import type { DirectoryAmbulance, MatchType } from "../directory/matcher";
import type { DirectoryClinic } from "../directory/repo";
import { HandleRegistry, TOKEN_RE } from "./handles";
import { buildAmbulanceCard, buildMultiAmbulanceCard, formatIndianPhone, renderNumberForToken } from "../messages/cards";
import { mapsLink } from "../links";

export interface RenderLookups {
  ambulance(id: string): Promise<DirectoryAmbulance | undefined>;
  clinic(id: string): Promise<DirectoryClinic | undefined>;
}

export interface RenderInput {
  replyTemplate: string;
  lang: Language;
  intent: Intent;
  registry: HandleRegistry;
  lookups: RenderLookups;
  helplinePhone: string;
  staticPhones: Record<string, string>;
  lastAmbulanceCandidates: DirectoryAmbulance[] | null;
  /** How lastAmbulanceCandidates matched: the card fallback fires only for "area" or "city". */
  lastAmbulanceMatch: MatchType | null;
}

export interface RenderResult {
  text: string;
  /** The model's reply with every token in canonical form ({{AMB:<handle>}}): what `text` was rendered from. */
  template: string;
  /**
   * `template` with every dropped token and leftover syntax removed and the text's formatting cleanup applied: the
   * template of what `text` says, holding a token for each number and map link it shows (the card excepted), so a
   * transcript built from it never shows the model writing something the reporter did not get.
   */
  sentTemplate: string;
  /** Every number in `text` as stored: the substituted tokens' in order of first use, then the card's. */
  inserted: string[];
  /**
   * Every map link in `text` ({{MAPS}} tokens'), in order of first use: inserted by code like the numbers, so the digit
   * guard masks them before it reads the text.
   */
  links: string[];
  /**
   * Values of the tokens dropped (an unknown, retired or wrong-kind handle, an unknown PHONE key, a MAPS token whose
   * hospital or clinic has no map link), then any leftover template syntax, as written.
   */
  unknownHandles: string[];
  appendedCard: boolean;
}

/** Replies stay under WhatsApp's 4096-character limit. */
const MAX_REPLY_CHARS = 4000;

/** WhatsApp formatting: *bold* for **bold**, no headings, "•" bullets, at most one blank line, no outer whitespace. */
export function cleanupFormatting(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*]\s+/gm, "• ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * A token as the model may write it: whitespace or line breaks inside the braces and any case for the kind
 * ("{{ PHONE: helpline }}", "{{amb:amb_abcdefgh}}", "{{AMB:\namb_abcdefgh}}", "{{ Maps : cli_abcdefgh }}", "{{MAP:cli_abcdefgh}}").
 */
const LOOSE_TOKEN_RE = /\{\{\s*(amb|clinic|maps?|phone)\s*:\s*([A-Za-z0-9_-]+)\s*\}\}/gi;

/** A handle's 8-letter body without its kind prefix: the model sometimes writes {{AMB:kcmfpbca}} for amb_kcmfpbca. */
const BARE_HANDLE_RE = /^[a-p]{8}$/i;

/**
 * Rewrites every loosely written token as {{KIND:value}}: the kind uppercased (MAP read as MAPS), the value as written,
 * except that an AMB, CLINIC or MAPS value that is a bare 8-letter handle body gets its amb_/cli_ prefix back
 * (seen in the first real smoke run: the model dropped the prefix and the number would have been lost).
 */
function canonicalizeTokens(text: string): string {
  return text.replace(LOOSE_TOKEN_RE, (_, kind: string, value: string) => {
    const upper = kind.toUpperCase() === "MAP" ? "MAPS" : kind.toUpperCase();
    let v = value;
    if (upper === "AMB" && BARE_HANDLE_RE.test(v)) v = `amb_${v.toLowerCase()}`;
    else if ((upper === "CLINIC" || upper === "MAPS") && BARE_HANDLE_RE.test(v)) v = `cli_${v.toLowerCase()}`;
    return `{{${upper}:${v}}}`;
  });
}

/** Handles and PHONE keys resolve case-insensitively, so {{AMB:amb_x}} and {{AMB:AMB_X}} are one token. */
function tokenKey(kind: string, value: string): string {
  return `${kind}:${value.toLowerCase()}`;
}

/** A PHONE key's number, in any case. Own keys only, so {{PHONE:constructor}} never reaches an inherited member. */
function staticPhone(phones: Record<string, string>, key: string): string | undefined {
  if (Object.hasOwn(phones, key)) return phones[key];
  const match = Object.keys(phones).find((k) => k.toLowerCase() === key.toLowerCase());
  return match === undefined ? undefined : phones[match];
}

/**
 * Template syntax the token scan did not match: a brace group on one line ("{AMB:x}", "{{AMB: amb x}}") or a stray
 * brace ("{{{AMB:x}}}" leaves one on each side of the token).
 */
const LEFTOVER_RE = /\{+[^{}\n]*\}+|[{}]+/g;

/** Removes leftover template syntax from model-written text, recording each piece under its raw text. */
function dropLeftovers(text: string, dropped: string[]): string {
  return text.replace(LEFTOVER_RE, (raw) => {
    dropped.push(raw);
    return "";
  });
}

/**
 * While the model's text is cleaned and capped, each substituted number or map link stands in as one private-use
 * character (its slot), so no cleanup and no cut can reach into it. Private-use characters the model wrote are removed
 * first.
 */
const SLOT_BASE = 0xe000;
/**
 * What may stand glued right after an inserted link: whitespace, the end, or a run of ASCII sentence punctuation that ends
 * there ("…). ", "…, then"), which no linker reads as part of a URL. Anything else, a letter, digit or symbol in any script
 * ("/extra", "?x=1", a danda "।", a Devanagari word), gets a space first.
 */
const GLUED_AFTER_LINK = String.raw`(?=\S)(?![.,;:!?)]+(?:\s|$))`;
const PRIVATE_USE_RE = /[\uE000-\uF8FF]/g;

/** What a slot holds: a number (`value` as stored, `text` as shown) or a map link (both the link). */
interface Slot {
  kind: "number" | "link";
  value: string;
  text: string;
}

/**
 * The text with each slot expanded to its number or link, cut to at most `limit` UTF-16 units. A slot or a surrogate
 * pair that would not fit is dropped whole, with everything after it. `kept` receives the slots that made it in.
 */
function expandWithin(text: string, pieces: string[], limit: number, kept: Set<number>): string {
  let out = "";
  for (const ch of text) {
    const slot = ch.charCodeAt(0) - SLOT_BASE;
    const isSlot = slot >= 0 && slot < pieces.length;
    const piece = isSlot ? pieces[slot] : ch;
    if (out.length + piece.length > limit) break;
    if (isSlot) kept.add(slot);
    out += piece;
  }
  return out.trimEnd();
}

export async function renderReply(input: RenderInput): Promise<RenderResult> {
  const unknownHandles: string[] = [];
  const template = canonicalizeTokens(input.replyTemplate);
  // A fresh regex: matchAll resumes from a regex's lastIndex, which a caller's TOKEN_RE.test/exec leaves advanced.
  const tokens = Array.from(template.matchAll(new RegExp(TOKEN_RE.source, TOKEN_RE.flags)));

  // Each distinct token resolves once, to a slot in `slots`, or to "" when it is dropped.
  const slots: Slot[] = [];
  const slotOf = new Map<string, string>();
  const substitute = (key: string, kind: Slot["kind"], value: string, text: string) => {
    slotOf.set(key, String.fromCharCode(SLOT_BASE + slots.length));
    slots.push({ kind, value, text });
  };
  const drop = (key: string, value: string) => {
    unknownHandles.push(value);
    slotOf.set(key, "");
  };
  // Set only when an {{AMB}} token resolved to a unit: a dropped unknown handle must not switch the card fallback off.
  let hasAmbToken = false;
  for (const m of tokens) {
    const [, kind, value] = m;
    const key = tokenKey(kind, value);
    if (slotOf.has(key)) continue;
    if (kind === "PHONE") {
      const phone = value.toLowerCase() === "helpline" ? input.helplinePhone : staticPhone(input.staticPhones, value);
      if (phone) substitute(key, "number", phone, formatIndianPhone(phone));
      else drop(key, value);
      continue;
    }
    // AMB names a unit; CLINIC and MAPS name a hospital or clinic, by the same cli_ handle.
    const ref = input.registry.resolve(value);
    if (!ref || ref.kind !== (kind === "AMB" ? "ambulance" : "clinic")) {
      drop(key, value);
      continue;
    }
    if (ref.kind === "ambulance") {
      const row = await input.lookups.ambulance(ref.id);
      if (!row) { drop(key, value); continue; }
      substitute(key, "number", row.phone, renderNumberForToken(row, input.lang));
      hasAmbToken = true;
      continue;
    }
    const row = await input.lookups.clinic(ref.id);
    if (!row) { drop(key, value); continue; }
    if (kind === "MAPS") {
      // A hospital or clinic without a map link (or with a stored value that is no MAPS_URL_RE link): the token goes, as an
      // unknown handle's does.
      const link = mapsLink(row.mapsUrl);
      if (link) substitute(key, "link", link, link);
      else drop(key, value);
    } else {
      substitute(key, "number", row.phone, formatIndianPhone(row.phone));
    }
  }

  // Leftovers are removed only from the text between tokens, so no cleanup can cut into an inserted number.
  const between = (s: string) => dropLeftovers(s.replace(PRIVATE_USE_RE, ""), unknownHandles);
  const tidy = (s: string) => cleanupFormatting(s.replace(/[ \t]{2,}/g, " ").replace(/ +([.,!?])/g, "$1"));
  // The sent template is assembled beside the text: each substituted token stays a token, each dropped one goes.
  let text = "";
  let sent = "";
  let last = 0;
  for (const m of tokens) {
    const gap = between(template.slice(last, m.index));
    const slot = slotOf.get(tokenKey(m[1], m[2])) ?? "";
    text += gap + slot;
    sent += gap + (slot === "" ? "" : m[0]);
    last = m.index + m[0].length;
  }
  const tail = between(template.slice(last));
  text = tidy(text + tail);
  let sentTemplate = tidy(sent + tail);
  // A link ends where code ends it: text glued straight after it ("{{MAPS:x}}/extra", "{{MAPS:x}}।") goes after a space
  // (GLUED_AFTER_LINK), so WhatsApp never links the two as one; the sent template gets the same space after the token.
  const linkSlots = slots.flatMap((s, slot) => (s.kind === "link" ? [String.fromCharCode(SLOT_BASE + slot)] : []));
  if (linkSlots.length > 0) {
    text = text.replace(new RegExp(`([${linkSlots.join("")}])${GLUED_AFTER_LINK}`, "gu"), "$1 ");
    sentTemplate = sentTemplate.replace(new RegExp(`(\\{\\{MAPS:[A-Za-z0-9_-]+\\}\\})${GLUED_AFTER_LINK}`, "gu"), "$1 ");
  }

  let card = "";
  const cands = input.lastAmbulanceCandidates ?? [];
  // A looser match means the model is confirming the place, so a card would hand out a number it was told to hold.
  const exactMatch = input.lastAmbulanceMatch === "area" || input.lastAmbulanceMatch === "city";
  if (input.intent === "ambulance" && !hasAmbToken && exactMatch && cands.length >= 1 && cands.length <= 3) {
    card = cands.length === 1 ? buildAmbulanceCard(cands[0], input.lang) : buildMultiAmbulanceCard(cands, input.lang);
  }

  // The model's text is cut to leave room for the card: the card and every number and link stay whole.
  const kept = new Set<number>();
  const limit = card ? MAX_REPLY_CHARS - card.length - 2 : MAX_REPLY_CHARS;
  const body = expandWithin(text, slots.map((s) => s.text), limit, kept);
  const keptValues = (kind: Slot["kind"]) => slots.filter((s, slot) => s.kind === kind && kept.has(slot)).map((s) => s.value);
  const inserted = keptValues("number");
  if (card) inserted.push(...cands.map((c) => c.phone));
  return {
    text: card ? (body ? `${body}\n\n${card}` : card) : body,
    template,
    sentTemplate,
    inserted,
    links: keptValues("link"),
    unknownHandles,
    appendedCard: card !== "",
  };
}
