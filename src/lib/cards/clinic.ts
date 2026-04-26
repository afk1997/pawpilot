/**
 * Deterministic clinic-info card. Renders a list of clinics from DB rows.
 *
 * If a city hint is provided, restricts to clinics in that city; otherwise
 * lists up to 5 clinics.
 */
import type { Language } from "../types";
import { formatIndianPhone } from "../ambulance-card";

export interface ClinicRow {
  label: string;
  city: string;
  area: string | null;
  phone: string;
  address?: string | null;
  hours?: string | null;
}

const HEADER_BY_LANG: Record<Language, string> = {
  en: "Our clinics",
  hi: "हमारे क्लिनिक",
  mr: "आमचे क्लिनिक",
  gu: "અમારા ક્લિનિક",
};

const NO_CLINICS_BY_LANG: Record<Language, string> = {
  en: "We don't have a clinic in that city yet. Visit alwayscare.org/clinics for the full list.",
  hi: "उस शहर में अभी हमारा क्लिनिक नहीं है। पूरी सूची के लिए alwayscare.org/clinics देखें।",
  mr: "त्या शहरात अजून आमचे क्लिनिक नाही. संपूर्ण यादीसाठी alwayscare.org/clinics पहा.",
  gu: "તે શહેરમાં હજી અમારું ક્લિનિક નથી. સંપૂર્ણ યાદી માટે alwayscare.org/clinics જુઓ.",
};

const ANYTHING_ELSE_BY_LANG: Record<Language, string> = {
  en: "Anything else?",
  hi: "और कुछ?",
  mr: "अजून काही?",
  gu: "બીજું કંઈ?",
};

export function buildClinicCard(
  rows: ClinicRow[],
  language: Language = "en"
): string {
  if (rows.length === 0) {
    return NO_CLINICS_BY_LANG[language] ?? NO_CLINICS_BY_LANG.en;
  }

  const limited = rows.slice(0, 5);
  const lines: string[] = [HEADER_BY_LANG[language] ?? HEADER_BY_LANG.en, ""];

  for (const c of limited) {
    const place = c.area ? `${c.city} — ${c.area}` : c.city;
    lines.push(`*${c.label}* (${place})`);
    lines.push(`📞 ${formatIndianPhone(c.phone)}`);
    if (c.address) lines.push(`📍 ${c.address}`);
    if (c.hours) lines.push(`🕒 ${c.hours}`);
    lines.push("");
  }

  lines.push(ANYTHING_ELSE_BY_LANG[language] ?? ANYTHING_ELSE_BY_LANG.en);
  return lines.join("\n");
}
