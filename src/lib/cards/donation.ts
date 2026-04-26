/**
 * Deterministic donation info card.
 * Pulls the URL/UPI/etc. from src/content/static.json (orchestrator-side, not LLM).
 */
import type { Language } from "../types";
import staticContent from "@/content/static.json";

interface DonateContent {
  summary?: string;
  url?: string;
  upi?: string;
  bank?: string;
  tax_note?: string;
}

function readDonate(language: Language): DonateContent {
  const node =
    ((staticContent as unknown) as { donate?: Record<string, DonateContent> }).donate ?? {};
  // Per-field fallback: prefer requested language, fall back to English when
  // requested-language values are still "TODO".
  const en = node.en ?? {};
  const lang = node[language] ?? {};
  const pick = <K extends keyof DonateContent>(k: K): string | undefined => {
    const v = lang[k];
    if (typeof v === "string" && !v.startsWith("TODO")) return v;
    const fallback = en[k];
    if (typeof fallback === "string" && !fallback.startsWith("TODO")) return fallback;
    return undefined;
  };
  return {
    summary: pick("summary"),
    url: pick("url"),
    upi: pick("upi"),
    bank: pick("bank"),
    tax_note: pick("tax_note"),
  };
}

const HEADER_BY_LANG: Record<Language, string> = {
  en: "Thank you for considering a donation 🙏",
  hi: "दान के बारे में सोचने के लिए धन्यवाद 🙏",
  mr: "दान करण्याचा विचार केल्याबद्दल धन्यवाद 🙏",
  gu: "દાન વિશે વિચારવા બદલ આભાર 🙏",
};

const ANYTHING_ELSE_BY_LANG: Record<Language, string> = {
  en: "Anything else I can help with?",
  hi: "क्या मैं और कुछ मदद कर सकता हूँ?",
  mr: "अजून काही मदत करू शकतो का?",
  gu: "બીજું કંઈ મદદ કરી શકું?",
};

export function buildDonationCard(language: Language = "en"): string {
  const c = readDonate(language);
  const header = HEADER_BY_LANG[language] ?? HEADER_BY_LANG.en;
  const lines: string[] = [header];

  if (c.summary) lines.push("", c.summary);
  if (c.url) lines.push("", `🌐 ${c.url}`);
  if (c.upi) lines.push(`📱 UPI: ${c.upi}`);
  if (c.bank) lines.push(`🏦 ${c.bank}`);
  if (c.tax_note) lines.push("", `_${c.tax_note}_`);

  lines.push("", ANYTHING_ELSE_BY_LANG[language] ?? ANYTHING_ELSE_BY_LANG.en);
  return lines.join("\n");
}
