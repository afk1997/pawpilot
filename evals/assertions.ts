import { detectLanguage } from "../src/server/lang";
import { formatIndianPhone } from "../src/server/messages/cards";
import { foreignDigitRuns, hasDispatchLanguage } from "../src/server/agent/scrub";
import type { StructuredReply } from "../src/server/agent/types";
import type { Intent, Language } from "../src/server/types";

export interface StepExpect {
  contains?: string[];
  not_contains?: string[];
  regex?: string;
  language?: Language;
  intent?: Intent;
  number_of?: string[];
  no_foreign_digits?: boolean;
  no_dispatch?: boolean;
  turn_status?: "ok" | "fallback" | "failed";
  flagged?: boolean;
  message_count?: number;
  kind?: string;
  /** Every reply of the step is at most this many characters: the brevity check. */
  max_chars?: number;
}

export interface StepActual {
  messages: { content: string }[];
  turnStatus: string | null;
  structured: StructuredReply | null;
  flagged: boolean;
  outcomeKind: string;
  knownNumbers: Map<string, string>;
  /**
   * The numbers the step's messages may show, for no_foreign_digits: the helpline, the static content's phones, and the
   * numbers of the handles on the step's turn row (the units and clinics lookups gave the model, in this turn or an
   * earlier one); for a no-LLM fallback turn, which picks its units from the directory, every unit's number. Any other
   * phone-shaped run, in any script, is foreign: digits the model typed that reached the reporter.
   */
  allowedNumbers: string[];
}

export function checkStep(expect: StepExpect, actual: StepActual): string[] {
  const fails: string[] = [];
  const text = actual.messages.map((m) => m.content).join("\n");
  for (const s of expect.contains ?? []) if (!text.includes(s)) fails.push(`contains: missing "${s}"`);
  for (const s of expect.not_contains ?? []) if (text.includes(s)) fails.push(`not_contains: found "${s}"`);
  if (expect.regex && !new RegExp(expect.regex, "i").test(text)) fails.push(`regex: ${expect.regex} did not match`);
  if (expect.language) {
    const lang = actual.structured?.language ?? detectLanguage(text);
    if (lang !== expect.language) fails.push(`language: expected ${expect.language}, got ${lang}`);
  }
  if (expect.intent && actual.structured?.intent !== expect.intent) fails.push(`intent: expected ${expect.intent}, got ${actual.structured?.intent ?? "none"}`);
  for (const label of expect.number_of ?? []) {
    const phone = actual.knownNumbers.get(label);
    if (!phone) fails.push(`number_of: unknown fixture label ${label}`);
    else if (!text.includes(formatIndianPhone(phone))) fails.push(`number_of: ${label} (${formatIndianPhone(phone)}) not in reply`);
  }
  if (expect.no_foreign_digits) {
    const foreign = foreignDigitRuns(text, actual.allowedNumbers);
    if (foreign.length) fails.push(`foreign digits present: ${foreign.join(", ")}`);
  }
  if (expect.no_dispatch && hasDispatchLanguage(text)) fails.push("dispatch language present");
  if (expect.turn_status && actual.turnStatus !== expect.turn_status) fails.push(`turn_status: expected ${expect.turn_status}, got ${actual.turnStatus}`);
  // The fallback answers from the directory alone: a step that does not expect it never passes on the fallback's card.
  if (!expect.turn_status && expect.kind !== "fallback" && actual.turnStatus === "fallback") fails.push("turn_status: the turn fell back, which the step does not expect");
  if (expect.flagged !== undefined && actual.flagged !== expect.flagged) fails.push(`flagged: expected ${expect.flagged}, got ${actual.flagged}`);
  if (expect.message_count !== undefined && actual.messages.length !== expect.message_count) fails.push(`message_count: expected ${expect.message_count}, got ${actual.messages.length}`);
  if (expect.kind && actual.outcomeKind !== expect.kind) fails.push(`kind: expected ${expect.kind}, got ${actual.outcomeKind}`);
  if (expect.max_chars !== undefined) {
    for (const m of actual.messages) if (m.content.length > expect.max_chars) fails.push(`max_chars: a reply has ${m.content.length} characters, over ${expect.max_chars}`);
  }
  return fails;
}
