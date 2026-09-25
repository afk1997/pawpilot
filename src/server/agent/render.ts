import type { Intent, Language } from "../types";
import type { DirectoryAmbulance, MatchType } from "../directory/matcher";
import type { DirectoryClinic } from "../directory/repo";
import { HandleRegistry, TOKEN_RE } from "./handles";
import { buildAmbulanceCard, buildMultiAmbulanceCard, formatIndianPhone, renderNumberForToken } from "../messages/cards";

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
  template: string;
  inserted: string[];
  unknownHandles: string[];
  appendedCard: boolean;
}

export function cleanupFormatting(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*]\s+/gm, "• ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 4000);
}

/**
 * Template syntax the token scan did not match: a brace group on one line ("{{AMB: x}}", "{{amb:x}}",
 * "{x}") or a stray brace ("{{{AMB:x}}}" leaves one on each side of the token).
 */
const LEFTOVER_RE = /\{+[^{}\n]*\}+|[{}]+/g;

/** Removes leftover template syntax from model-written text, recording each piece under its raw text. */
function dropLeftovers(text: string, dropped: string[]): string {
  return text.replace(LEFTOVER_RE, (raw) => {
    dropped.push(raw);
    return "";
  });
}

export async function renderReply(input: RenderInput): Promise<RenderResult> {
  const inserted: string[] = [];
  const unknownHandles: string[] = [];
  const template = input.replyTemplate;
  // A fresh regex: matchAll resumes from a regex's lastIndex, which a caller's TOKEN_RE.test/exec leaves advanced.
  const tokens = Array.from(template.matchAll(new RegExp(TOKEN_RE.source, TOKEN_RE.flags)));

  const replacements = new Map<string, string>();
  // Set only when an {{AMB}} token resolved to a unit: a dropped unknown handle must not switch the card fallback off.
  let hasAmbToken = false;
  for (const m of tokens) {
    const [raw, kind, value] = m;
    if (replacements.has(raw)) continue;
    if (kind === "PHONE") {
      // Own keys only, so {{PHONE:constructor}} or {{PHONE:__proto__}} never reaches an inherited member.
      const phone = value === "helpline" ? input.helplinePhone : Object.hasOwn(input.staticPhones, value) ? input.staticPhones[value] : undefined;
      if (!phone) { unknownHandles.push(value); replacements.set(raw, ""); continue; }
      inserted.push(phone);
      replacements.set(raw, formatIndianPhone(phone));
      continue;
    }
    const ref = input.registry.resolve(value);
    if (!ref || (kind === "AMB" && ref.kind !== "ambulance") || (kind === "CLINIC" && ref.kind !== "clinic")) {
      unknownHandles.push(value);
      replacements.set(raw, "");
      continue;
    }
    if (ref.kind === "ambulance") {
      const row = await input.lookups.ambulance(ref.id);
      if (!row) { unknownHandles.push(value); replacements.set(raw, ""); continue; }
      inserted.push(row.phone);
      replacements.set(raw, renderNumberForToken(row, input.lang));
      hasAmbToken = true;
    } else {
      const row = await input.lookups.clinic(ref.id);
      if (!row) { unknownHandles.push(value); replacements.set(raw, ""); continue; }
      inserted.push(row.phone);
      replacements.set(raw, formatIndianPhone(row.phone));
    }
  }

  // Leftovers are removed only from the text between tokens, so no cleanup can cut into an inserted number.
  let text = "";
  let last = 0;
  for (const m of tokens) {
    text += dropLeftovers(template.slice(last, m.index), unknownHandles) + (replacements.get(m[0]) ?? "");
    last = m.index + m[0].length;
  }
  text += dropLeftovers(template.slice(last), unknownHandles);
  text = text.replace(/[ \t]{2,}/g, " ").replace(/ +([.,!?])/g, "$1");

  let appendedCard = false;
  const cands = input.lastAmbulanceCandidates ?? [];
  // A looser match means the model is confirming the place, so a card would hand out a number it was told to hold.
  const exactMatch = input.lastAmbulanceMatch === "area" || input.lastAmbulanceMatch === "city";
  if (input.intent === "ambulance" && !hasAmbToken && exactMatch && cands.length >= 1 && cands.length <= 3) {
    const card = cands.length === 1 ? buildAmbulanceCard(cands[0], input.lang) : buildMultiAmbulanceCard(cands, input.lang);
    text = `${text.trim()}\n\n${card}`;
    for (const c of cands) inserted.push(c.phone);
    appendedCard = true;
  }

  return { text: cleanupFormatting(text), template, inserted, unknownHandles, appendedCard };
}
