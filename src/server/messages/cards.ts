import { getConfig } from "../config";
import type { Language } from "../types";

export interface CardAmbulance {
  city: string;
  area: string | null;
  phone: string;
  operatorName: string;
  operatorIsArham: boolean;
}

export interface CardClinic {
  label: string;
  city: string;
  area: string | null;
  phone: string;
  address?: string | null;
  hours?: string | null;
}

/**
 * "+917000000001" → "+91 70000 00001"; toll-free "18004195860" → "1800-419-5860" (no country code).
 * Non-Indian numbers are returned as-is with a "+".
 */
export function formatIndianPhone(e164: string): string {
  if (!e164) return e164;
  const digits = e164.replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) {
    const local = digits.slice(2);
    return `+91 ${local.slice(0, 5)} ${local.slice(5)}`;
  }
  if (digits.length === 10) return `+91 ${digits.slice(0, 5)} ${digits.slice(5)}`;
  if (digits.length === 11 && digits.startsWith("1800")) return `1800-${digits.slice(4, 7)}-${digits.slice(7)}`;
  return e164.startsWith("+") ? e164 : `+${e164}`;
}

const CALL_PROMPT: Record<Language, string> = {
  en: "Please call them right away.",
  hi: "कृपया उन्हें तुरंत कॉल करें।",
  mr: "कृपया त्यांना लगेच कॉल करा.",
  gu: "કૃપા કરીને તેમને તરત જ કૉલ કરો.",
};

const OPERATED_BY: Record<Language, (op: string) => string> = {
  en: (op) => `(operated by ${op})`,
  hi: (op) => `(${op} द्वारा संचालित)`,
  mr: (op) => `(${op} द्वारे चालवले जाते)`,
  gu: (op) => `(${op} દ્વારા સંચાલિત)`,
};

export function partnerSuffix(operatorName: string, lang: Language): string {
  return (OPERATED_BY[lang] ?? OPERATED_BY.en)(operatorName);
}

export function ambulanceDisplayName(row: CardAmbulance): string {
  const place = row.area && row.area.trim().length > 0 ? row.area : row.city;
  return row.operatorIsArham ? `Arham Animal Ambulance, ${place}` : `Animal Ambulance, ${place}`;
}

/** What replaces an {{AMB:handle}} token inside the model's sentence. */
export function renderNumberForToken(row: CardAmbulance, lang: Language): string {
  const phone = formatIndianPhone(row.phone);
  return row.operatorIsArham ? phone : `${phone} ${partnerSuffix(row.operatorName, lang)}`;
}

export function buildAmbulanceCard(row: CardAmbulance, lang: Language = "en"): string {
  const lines = [ambulanceDisplayName(row), formatIndianPhone(row.phone)];
  if (!row.operatorIsArham) lines.push(partnerSuffix(row.operatorName, lang));
  lines.push(CALL_PROMPT[lang] ?? CALL_PROMPT.en);
  return lines.join("\n");
}

const MULTI_HEADER: Record<Language, (n: number, place: string) => string> = {
  en: (n, p) => `${n} ambulances are available in ${p}. Please call any one of them:`,
  hi: (n, p) => `${p} में ${n} एम्बुलेंस उपलब्ध हैं। कृपया इनमें से किसी एक को कॉल करें:`,
  mr: (n, p) => `${p} मध्ये ${n} एम्बुलन्स उपलब्ध आहेत. कृपया यांपैकी कोणालाही कॉल करा:`,
  gu: (n, p) => `${p} માં ${n} એમ્બ્યુલન્સ ઉપલબ્ધ છે. કૃપા કરીને કોઈ પણ એકને કૉલ કરો:`,
};

/** Header for units in different cities (e.g. a matcher run without a city), where naming one city would mislead. */
const MULTI_HEADER_NO_CITY: Record<Language, (n: number) => string> = {
  en: (n) => `${n} ambulances are available. Please call any one of them:`,
  hi: (n) => `${n} एम्बुलेंस उपलब्ध हैं। कृपया इनमें से किसी एक को कॉल करें:`,
  mr: (n) => `${n} एम्बुलन्स उपलब्ध आहेत. कृपया यांपैकी कोणालाही कॉल करा:`,
  gu: (n) => `${n} એમ્બ્યુલન્સ ઉપલબ્ધ છે. કૃપા કરીને કોઈ પણ એકને કૉલ કરો:`,
};

export function buildMultiAmbulanceCard(rows: CardAmbulance[], lang: Language = "en"): string {
  if (rows.length === 0) return "";
  if (rows.length === 1) return buildAmbulanceCard(rows[0], lang);
  const city = rows[0].city;
  const header = rows.every((r) => r.city === city)
    ? (MULTI_HEADER[lang] ?? MULTI_HEADER.en)(rows.length, city)
    : (MULTI_HEADER_NO_CITY[lang] ?? MULTI_HEADER_NO_CITY.en)(rows.length);
  const lines: string[] = [header, ""];
  rows.forEach((row, i) => {
    lines.push(`${i + 1}. ${ambulanceDisplayName(row)}`);
    lines.push(`   ${formatIndianPhone(row.phone)}`);
    if (!row.operatorIsArham) lines.push(`   ${partnerSuffix(row.operatorName, lang)}`);
    lines.push("");
  });
  return lines.join("\n").trimEnd();
}

const HELPLINE_INTRO: Record<Language, string> = {
  en: "Please call the Arham Always Care helpline and our team will help you:",
  hi: "कृपया Arham Always Care हेल्पलाइन पर कॉल करें, हमारी टीम आपकी मदद करेगी:",
  mr: "कृपया Arham Always Care हेल्पलाइनला कॉल करा, आमची टीम तुम्हाला मदत करेल:",
  gu: "કૃપા કરીને Arham Always Care હેલ્પલાઇન પર કૉલ કરો, અમારી ટીમ તમને મદદ કરશે:",
};

export function buildHelplineCard(phone: string, lang: Language = "en"): string {
  return `${HELPLINE_INTRO[lang] ?? HELPLINE_INTRO.en}\n${formatIndianPhone(phone)}`;
}

const CLINIC_HEADER: Record<Language, string> = { en: "Our clinics", hi: "हमारे क्लिनिक", mr: "आमचे क्लिनिक", gu: "અમારા ક્લિનિક" };
const NO_CLINICS: Record<Language, (clinicsUrl: string) => string> = {
  en: (url) => `We don't have a clinic in that city yet. Visit ${url} for the full list.`,
  hi: (url) => `उस शहर में अभी हमारा क्लिनिक नहीं है। पूरी सूची के लिए ${url} देखें।`,
  mr: (url) => `त्या शहरात अजून आमचे क्लिनिक नाही. संपूर्ण यादीसाठी ${url} पहा.`,
  gu: (url) => `તે શહેરમાં હજી અમારું ક્લિનિક નથી. સંપૂર્ણ યાદી માટે ${url} જુઓ.`,
};

/** The clinic list on the configured website (WEBSITE_URL), so the link cannot drift from it. */
function clinicsUrl(): string {
  return `${getConfig().websiteUrl.replace(/\/+$/, "")}/clinics`;
}

export function buildClinicCard(rows: CardClinic[], lang: Language = "en"): string {
  if (rows.length === 0) return (NO_CLINICS[lang] ?? NO_CLINICS.en)(clinicsUrl());
  const lines: string[] = [CLINIC_HEADER[lang] ?? CLINIC_HEADER.en, ""];
  for (const c of rows.slice(0, 5)) {
    lines.push(`*${c.label}* (${c.area ? `${c.city} — ${c.area}` : c.city})`);
    lines.push(`📞 ${formatIndianPhone(c.phone)}`);
    if (c.address) lines.push(`📍 ${c.address}`);
    if (c.hours) lines.push(`🕒 ${c.hours}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
