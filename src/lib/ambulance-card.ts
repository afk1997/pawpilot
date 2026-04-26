/**
 * Deterministic ambulance card formatter.
 *
 * The LLM is FORBIDDEN from formatting ambulance delivery messages itself.
 * This module owns the format. When tools return ambulance rows, the
 * orchestrator calls buildAmbulanceCard() to construct the exact message
 * the reporter will see.
 *
 * Format examples:
 *
 *   Arham-operated:
 *     Arham Animal Ambulance, Ghatkopar
 *     +91 76620 05404
 *     Please call them right away.
 *
 *   Partner-operated:
 *     Animal Ambulance, Wadala
 *     +91 91671 19135
 *     (operated by Hope for Indies Trust)
 *     Please call them right away.
 */

import type { Language } from "./types";

export interface AmbulanceRowMinimal {
  city: string;
  area: string | null;
  phone: string; // E.164 form: +91XXXXXXXXXX
  operator_name: string;
  operator_is_arham: boolean;
}

export interface AmbulanceCard {
  display_name: string;
  phone_formatted: string;
  operator_suffix: string | null;
  /** The full message the agent should send, WhatsApp-ready. */
  full_message: string;
}

/** "+917662005404" → "+91 76620 05404". Defensive on shape. */
export function formatIndianPhone(e164: string): string {
  if (!e164) return e164;
  const digits = e164.replace(/\D/g, "");
  // Indian: 12 digits with leading 91
  if (digits.length === 12 && digits.startsWith("91")) {
    const local = digits.slice(2);
    return `+91 ${local.slice(0, 5)} ${local.slice(5)}`;
  }
  // Just 10 digits → assume India
  if (digits.length === 10) {
    return `+91 ${digits.slice(0, 5)} ${digits.slice(5)}`;
  }
  // Other → return as-is with '+' prefix
  return e164.startsWith("+") ? e164 : `+${e164}`;
}

const CALL_PROMPT_BY_LANG: Record<Language, string> = {
  en: "Please call them right away.",
  hi: "कृपया उन्हें तुरंत कॉल करें।",
  mr: "कृपया त्यांना लगेच कॉल करा.",
  gu: "કૃપા કરીને તેમને તરત જ કૉલ કરો.",
};

const OPERATED_BY_BY_LANG: Record<Language, (operator: string) => string> = {
  en: (op) => `(operated by ${op})`,
  hi: (op) => `(${op} द्वारा संचालित)`,
  mr: (op) => `(${op} द्वारे चालवले जाते)`,
  gu: (op) => `(${op} દ્વારા સંચાલિત)`,
};

/**
 * Build the deterministic ambulance card for the given row.
 * Caller passes the language so the call-to-action line is localized.
 */
export function buildAmbulanceCard(
  row: AmbulanceRowMinimal,
  language: Language = "en"
): AmbulanceCard {
  const place = row.area && row.area.trim().length > 0 ? row.area : row.city;
  const phone_formatted = formatIndianPhone(row.phone);

  let display_name: string;
  let operator_suffix: string | null;

  if (row.operator_is_arham) {
    display_name = `Arham Animal Ambulance, ${place}`;
    operator_suffix = null;
  } else {
    display_name = `Animal Ambulance, ${place}`;
    operator_suffix = OPERATED_BY_BY_LANG[language](row.operator_name);
  }

  const callPrompt = CALL_PROMPT_BY_LANG[language] ?? CALL_PROMPT_BY_LANG.en;

  const lines = [display_name, phone_formatted];
  if (operator_suffix) lines.push(operator_suffix);
  lines.push(callPrompt);

  return {
    display_name,
    phone_formatted,
    operator_suffix,
    full_message: lines.join("\n"),
  };
}

const MULTI_HEADER_BY_LANG: Record<Language, (n: number, place: string) => string> = {
  en: (n, p) => `${n} ambulances are available in ${p}. Please call any one of them:`,
  hi: (n, p) => `${p} में ${n} एम्बुलेंस उपलब्ध हैं। कृपया इनमें से किसी एक को कॉल करें:`,
  mr: (n, p) => `${p} मध्ये ${n} एम्बुलन्स उपलब्ध आहेत. कृपया यांपैकी कोणालाही कॉल करा:`,
  gu: (n, p) => `${p} માં ${n} એમ્બ્યુલન્સ ઉપલબ્ધ છે. કૃપા કરીને કોઈ પણ એકને કૉલ કરો:`,
};

/**
 * Build a single multi-ambulance card when we have 2-3 matching rows that
 * can't be disambiguated by area (e.g. Rajkot's two partner NGOs both
 * cover the whole city). Lists each option with phone + operator suffix.
 */
export function buildMultiAmbulanceCard(
  rows: AmbulanceRowMinimal[],
  language: Language = "en"
): string {
  if (rows.length === 0) return "";
  if (rows.length === 1) return buildAmbulanceCard(rows[0], language).full_message;

  // Use the city of the first row as the place label (assumes same city).
  const place = rows[0].city;
  const header = MULTI_HEADER_BY_LANG[language](rows.length, place);

  const lines: string[] = [header, ""];
  rows.forEach((row, idx) => {
    const card = buildAmbulanceCard(row, language);
    lines.push(`${idx + 1}. ${card.display_name}`);
    lines.push(`   ${card.phone_formatted}`);
    if (card.operator_suffix) lines.push(`   ${card.operator_suffix}`);
    lines.push("");
  });

  return lines.join("\n").trimEnd();
}
