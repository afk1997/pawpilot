import type { DirectoryAmbulance, MatchType } from "../directory/matcher";
import type { DirectoryClinic } from "../directory/repo";
import { foldDigits } from "../content/static";
import { buildHelplineCard, formatIndianPhone, renderNumberForToken } from "../messages/cards";
import { callDirectlyLine, DISPATCH_CORRECTION_NOTE, LINK_CORRECTION_NOTE, staleHandleNote, TOKEN_CORRECTION_NOTE } from "../messages/system-replies";
import { isWebsiteLink } from "../links";
import { extractTokens, type HandleRegistry } from "./handles";
import { renderReply, type RenderLookups, type RenderResult } from "./render";
import {
  findDigitRuns, foreignDigitRuns, hasDispatchLanguage, replaceDigitRuns, replaceDispatchSentences, sameNumber, stripLinks, stripRuns, typedLinks,
} from "./scrub";
import type { StructuredReply } from "./types";

/**
 * The guards a reply meets before it is sent (spec §5.9), free of the database and the backend: the caller supplies
 * the directory lookups and the corrective call. Every draft is rendered, then checked by the digit guard, a stale
 * handle check and the dispatch guard, and the numbers code inserted in any draft are kept.
 */

const DIGIT_RE = /\p{Nd}/u;
/** A dropped piece of template syntax always holds a brace; a dropped token's value never does. */
const SYNTAX_RE = /[{}]/;
/** A handle as makeHandle writes it (letters only): the only dropped value an event may carry. */
const HANDLE_RE = /^(?:amb|cli)_[a-p]{8}$/i;
/**
 * A dropped piece of syntax that named an AMB, CLINIC or MAPS token: the model meant to give a unit's or a clinic's number
 * or a clinic's map link.
 */
const ENTITY_SYNTAX_RE = /\b(?:AMB|CLINIC|MAPS?)\b/i;

/** Which guard asks for a corrective call. */
export type CorrectionPurpose = "token" | "dispatch";

export interface GuardDeps {
  registry: HandleRegistry;
  lookups: RenderLookups;
  helplinePhone: string;
  staticPhones: Record<string, string>;
  /** The website (WEBSITE_URL): the only host the model may type a link to. */
  websiteUrl: string;
  /** The last find_ambulances result as it stands when a draft is rendered: a corrective call can change it. */
  toolState: () => { candidates: DirectoryAmbulance[] | null; match: MatchType | null };
  /** Every phone-shaped run in this turn's tool outputs so far: numbers the model may repeat. */
  toolRuns: () => string[];
  /** One corrective call: the corrected reply, or null when none came (no time left, or the call failed). */
  retry: (correction: string, purpose: CorrectionPurpose) => Promise<StructuredReply | null>;
}

export interface GuardedReply {
  /** The reply to send; empty when nothing survived the guards and no number was left to send again. */
  text: string;
  /** Its template: a token for each number it shows (the card excepted), nothing the reporter did not get. */
  template: string;
  /** The last draft's structured reply, with needs_human set when any draft of the turn set it. */
  structured: StructuredReply;
  /** The sent draft had digits the model typed removed: phone-shaped runs, or dropped pieces holding a digit. */
  scrubbed: boolean;
  /** Links the model typed (to anywhere but the website) that were removed from the sent draft. */
  linksStripped: number;
  foreignRuns: number;
  digitDrops: number;
  /** A sentence with dispatch language was replaced. */
  replaced: boolean;
  /** Numbers a draft of this turn inserted that the reply lacked, sent again after the call-directly line. */
  restored: number;
  /** Handles the registry does not know, in the sent draft; handle-shaped, so free of digits. */
  unknownHandles: string[];
  /** Handles of units or clinics no longer active, still in the sent draft. */
  staleHandles: string[];
  /** Template syntax the sent draft dropped. */
  droppedSyntax: string[];
}

/** One reply the model wrote, rendered, with what the guards found in it. */
interface Draft {
  structured: StructuredReply;
  rendered: RenderResult;
  /**
   * The digit guard's allow-list: the numbers and the map links code inserted (a link is masked as written, so its
   * coordinates are never read as typed digits), and every run in this turn's tool outputs.
   */
  allowed: string[];
  /** Phone-shaped runs the model typed. */
  foreign: string[];
  /**
   * Links the model typed to anywhere but the website: it never sees a real map link (tools return the {{MAPS}} token),
   * so a map link it types is invented, and a wrong pin sends a reporter to the wrong place.
   */
  foreignLinks: string[];
  /** Dropped tokens or template syntax holding a digit: a number the model tried to write inside a token. */
  digitDrops: string[];
  /** Handles whose unit or clinic is no longer active. */
  stale: string[];
}

const typedDigits = (d: Draft) => d.foreign.length > 0 || d.digitDrops.length > 0;
const typedForeignLinks = (d: Draft) => d.foreignLinks.length > 0;

/**
 * replaceDispatchSentences on a template. Its numbers and links are tokens, which that function does not see, so a token
 * inside a replaced sentence goes back right after the replacement line, as its number or link does in the text.
 */
function replaceDispatchInTemplate(template: string, line: string, allowed: string[]): string {
  const out = replaceDispatchSentences(template, line, allowed);
  const lost = [...new Set(extractTokens(template).map((t) => t.raw))].filter((raw) => !out.includes(raw));
  if (lost.length === 0) return out;
  const at = out.indexOf(line);
  if (at < 0) return `${out} ${lost.join(" ")}`;
  const end = at + line.length;
  return `${out.slice(0, end)} ${lost.join(" ")}${out.slice(end)}`;
}

const appendLine = (text: string, line: string) => (text.trim() === "" ? line : `${text}\n\n${line}`);

/**
 * The guard pipeline for one reply (spec §5.9). Each draft is rendered from its native-numeral-folded reply. The digit
 * guard (typed runs, or dropped pieces holding a digit) and a stale handle get one corrective call, then typed runs are
 * stripped; the dispatch guard gets one, whose draft meets the digit guard again, then its sentences are replaced.
 * Every number any draft inserted must reach the reporter (the numbers are code-inserted, so safe): one the final
 * reply lacks goes out again after the call-directly line. A map link code inserted for a {{MAPS}} token is masked from
 * the digit guard like an inserted number and kept by the dispatch replacement; it is not sent again when the final
 * reply lacks it. A reply of any intent left with no number at all after an AMB, CLINIC or MAPS token was dropped
 * (retired, invented, malformed, or a MAPS token for a facility without a map link) gets the helpline card. needs_human
 * holds if any draft set it, and then no draft after it gets a guessed card.
 */
export async function guardReply(first: StructuredReply, deps: GuardDeps): Promise<GuardedReply> {
  const { registry } = deps;
  // Rows met while rendering, by phone, so a number sent again keeps its partner label and its token.
  const rows = new Map<string, { kind: "ambulance"; row: DirectoryAmbulance } | { kind: "clinic"; row: DirectoryClinic }>();
  // Ids a handle points at whose unit or clinic is no longer active.
  const gone = new Set<string>();
  const lookups: RenderLookups = {
    ambulance: async (id) => {
      const row = await deps.lookups.ambulance(id);
      if (row) rows.set(row.phone, { kind: "ambulance", row });
      else gone.add(id);
      return row;
    },
    clinic: async (id) => {
      const row = await deps.lookups.clinic(id);
      if (row) rows.set(row.phone, { kind: "clinic", row });
      else gone.add(id);
      return row;
    },
  };
  const inserted = new Set<string>();
  let needsHuman = false;
  /** Some draft dropped an AMB, CLINIC or MAPS token: retired, invented, malformed, or a facility without a map link. */
  let entityDropped = false;

  const draft = async (structured: StructuredReply): Promise<Draft> => {
    needsHuman ||= structured.needs_human;
    const { candidates, match } = deps.toolState();
    const rendered = await renderReply({
      // Native numerals as ASCII first, so a number in any script meets the guards as one.
      replyTemplate: foldDigits(structured.reply),
      lang: structured.language,
      intent: structured.intent,
      registry,
      lookups,
      helplinePhone: deps.helplinePhone,
      staticPhones: deps.staticPhones,
      // A turn that hands the reporter to a person gets no guessed unit card.
      lastAmbulanceCandidates: needsHuman ? null : candidates,
      lastAmbulanceMatch: match,
    });
    if (rendered.appendedCard) for (const c of candidates ?? []) rows.set(c.phone, { kind: "ambulance", row: c });
    for (const phone of rendered.inserted) inserted.add(phone);
    // Never the numbers of earlier replies: the transcript masks them, so the model retyping one is a leak.
    const allowed = [...rendered.inserted, ...rendered.links, ...deps.toolRuns()];
    const stale = rendered.unknownHandles.filter((dropped) => {
      const ref = registry.resolve(dropped);
      return ref !== undefined && gone.has(ref.id);
    });
    const droppedValues = new Set(rendered.unknownHandles.map((v) => v.toLowerCase()));
    if (
      extractTokens(rendered.template).some((t) => t.kind !== "PHONE" && droppedValues.has(t.value.toLowerCase())) ||
      rendered.unknownHandles.some((v) => SYNTAX_RE.test(v) && ENTITY_SYNTAX_RE.test(v))
    ) {
      entityDropped = true;
    }
    return {
      structured,
      rendered,
      allowed,
      foreign: foreignDigitRuns(rendered.text, allowed),
      // Code-inserted links are kept apart (splitAllowed), so only what the model typed is read.
      foreignLinks: typedLinks(rendered.text, rendered.links).filter((link) => !isWebsiteLink(link, deps.websiteUrl)),
      digitDrops: rendered.unknownHandles.filter((dropped) => DIGIT_RE.test(dropped)),
      stale,
    };
  };

  /**
   * The draft's text and sent template with the links and the runs the model typed stripped from both: the links first, so
   * a run inside a typed link ("https://wa.me/…") never leaves the rest of the link behind.
   */
  const guarded = (d: Draft): { text: string; template: string } => {
    let text = d.rendered.text;
    let template = d.rendered.sentTemplate;
    if (typedForeignLinks(d)) {
      text = stripLinks(text, d.foreignLinks, d.rendered.links);
      template = stripLinks(template, d.foreignLinks, []);
    }
    if (!typedDigits(d)) return { text, template };
    return {
      text: d.foreign.length > 0 ? stripRuns(text, d.foreign, d.allowed) : text,
      template: stripRuns(template, foreignDigitRuns(template, d.allowed), d.allowed),
    };
  };

  let d = await draft(first);

  // Digit guard, typed links and a stale handle: one corrective call, then whatever is still typed is stripped. Each
  // problem found gets its own note: typed digits the token note, typed links the link note, retired handles the stale
  // note naming them.
  if (typedDigits(d) || typedForeignLinks(d) || d.stale.length > 0) {
    const notes = [
      ...(typedDigits(d) ? [TOKEN_CORRECTION_NOTE] : []),
      ...(typedForeignLinks(d) ? [LINK_CORRECTION_NOTE] : []),
      ...(d.stale.length > 0 ? [staleHandleNote(d.stale)] : []),
    ];
    const corrected = await deps.retry(notes.join(" "), "token");
    if (corrected) d = await draft(corrected);
  }
  let { text, template } = guarded(d);

  // Dispatch guard: one corrective call, whose draft meets the digit guard again, then sentence replacement.
  let replaced = false;
  if (hasDispatchLanguage(text)) {
    const corrected = await deps.retry(DISPATCH_CORRECTION_NOTE, "dispatch");
    if (corrected) {
      d = await draft(corrected);
      ({ text, template } = guarded(d));
    }
    if (hasDispatchLanguage(text)) {
      const line = callDirectlyLine(d.structured.language);
      text = replaceDispatchSentences(text, line, d.allowed);
      template = replaceDispatchInTemplate(template, line, d.allowed);
      replaced = true;
    }
  }

  const lang = d.structured.language;
  // An AMB, CLINIC or MAPS token was dropped (in any draft, the dispatch-corrected one included) and no draft gave any
  // number: the reply never goes out as "call this number:" with none, so the helpline card follows, its number inserted.
  if (entityDropped && inserted.size === 0) {
    const card = buildHelplineCard(deps.helplinePhone, lang);
    text = appendLine(text, card);
    template = appendLine(template, card.replace(formatIndianPhone(deps.helplinePhone), "{{PHONE:helpline}}"));
    inserted.add(deps.helplinePhone);
  }

  /** The template's form of a number code inserted: its token, or a marker when it has none. */
  const tokenFor = (phone: string) => {
    const seen = rows.get(phone);
    if (seen?.kind === "ambulance") return `{{AMB:${registry.ambulance(seen.row.id)}}}`;
    if (seen?.kind === "clinic") return `{{CLINIC:${registry.clinic(seen.row.id)}}}`;
    if (phone === deps.helplinePhone) return "{{PHONE:helpline}}";
    const key = Object.keys(deps.staticPhones).find((k) => deps.staticPhones[k] === phone);
    return key === undefined ? "[number sent]" : `{{PHONE:${key}}}`;
  };

  // Every number a draft inserted reaches the reporter: one the reply lacks goes out again, its token in the template.
  const lost = [...inserted].filter((phone) => !text.includes(formatIndianPhone(phone)));
  if (lost.length > 0) {
    const numberFor = (phone: string) => {
      const seen = rows.get(phone);
      return seen?.kind === "ambulance" ? renderNumberForToken(seen.row, lang) : formatIndianPhone(phone);
    };
    const line = callDirectlyLine(lang);
    text = appendLine(text, [line, ...lost.map(numberFor)].join(" "));
    template = appendLine(template, [line, ...lost.map(tokenFor)].join(" "));
  }

  // The template feeds the next transcript, which must never show digits: a run the model typed that the guards allowed
  // (an inserted number it retyped, a run from this turn's tools) goes in as that number's token, or as a marker.
  if (findDigitRuns(template).length > 0) {
    template = replaceDigitRuns(template, (run) => {
      const phone = [...inserted].find((p) => sameNumber(p, run));
      return phone === undefined ? "[number sent]" : tokenFor(phone);
    });
  }

  const dropped = d.rendered.unknownHandles;
  return {
    text,
    template,
    structured: { ...d.structured, needs_human: needsHuman },
    scrubbed: typedDigits(d),
    linksStripped: d.foreignLinks.length,
    foreignRuns: d.foreign.length,
    digitDrops: d.digitDrops.length,
    replaced,
    restored: lost.length,
    unknownHandles: dropped.filter((v) => HANDLE_RE.test(v) && !d.stale.includes(v)),
    staleHandles: d.stale.filter((v) => HANDLE_RE.test(v)),
    droppedSyntax: dropped.filter((v) => SYNTAX_RE.test(v)),
  };
}
