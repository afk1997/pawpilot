/**
 * Deterministic volunteer info card.
 */
import type { Language } from "../types";
import staticContent from "@/content/static.json";

interface VolunteerContent {
  summary?: string;
  url?: string;
  contact_phone?: string;
  contact_email?: string;
}

function readVolunteer(language: Language): VolunteerContent {
  const node =
    ((staticContent as unknown) as { volunteer?: Record<string, VolunteerContent> }).volunteer ??
    {};
  const en = node.en ?? {};
  const lang = node[language] ?? {};
  const pick = <K extends keyof VolunteerContent>(k: K): string | undefined => {
    const v = lang[k];
    if (typeof v === "string" && !v.startsWith("TODO")) return v;
    const fallback = en[k];
    if (typeof fallback === "string" && !fallback.startsWith("TODO")) return fallback;
    return undefined;
  };
  return {
    summary: pick("summary"),
    url: pick("url"),
    contact_phone: pick("contact_phone"),
    contact_email: pick("contact_email"),
  };
}

const HEADER_BY_LANG: Record<Language, string> = {
  en: "We'd love to have you on the team 🙌",
  hi: "हमारी टीम में आपका स्वागत है 🙌",
  mr: "तुमचं स्वागत आहे आमच्या टीममध्ये 🙌",
  gu: "અમારી ટીમમાં તમારું સ્વાગત છે 🙌",
};

const SHARE_HINT_BY_LANG: Record<Language, string> = {
  en: "You can also tell me your name and city, and we'll route you to the right team.",
  hi: "अपना नाम और शहर बताइए, और हम आपको सही टीम से जोड़ देंगे।",
  mr: "तुमचे नाव आणि शहर सांगा, आम्ही तुम्हाला योग्य टीमशी जोडू.",
  gu: "તમારું નામ અને શહેર જણાવો, અમે તમને યોગ્ય ટીમ સાથે જોડીશું.",
};

const ANYTHING_ELSE_BY_LANG: Record<Language, string> = {
  en: "Anything else?",
  hi: "और कुछ?",
  mr: "अजून काही?",
  gu: "બીજું કંઈ?",
};

export function buildVolunteerCard(language: Language = "en"): string {
  const c = readVolunteer(language);
  const lines: string[] = [HEADER_BY_LANG[language] ?? HEADER_BY_LANG.en];

  if (c.summary) lines.push("", c.summary);
  if (c.url) lines.push("", `🌐 ${c.url}`);
  if (c.contact_phone) lines.push(`📞 ${c.contact_phone}`);
  if (c.contact_email) lines.push(`✉️ ${c.contact_email}`);

  lines.push("", SHARE_HINT_BY_LANG[language] ?? SHARE_HINT_BY_LANG.en);
  lines.push("", ANYTHING_ELSE_BY_LANG[language] ?? ANYTHING_ELSE_BY_LANG.en);
  return lines.join("\n");
}
