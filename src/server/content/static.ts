import raw from "@/content/static.json";
import { LANGUAGES, type Language } from "../types";

export type InfoTopic = "donate" | "volunteer" | "about" | "faq" | "human_emergency" | "helpline";
export type InfoContent = Record<string, string | { question: string; answer: string }[]>;

type Localized = Record<string, Record<string, string> | string>;

const isFilled = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0 && !v.trim().toUpperCase().startsWith("TODO");
/** A field whose whole value is one phone number. */
const PHONE_RE = /^\+?\d[\d\s-]{6,}\d$/;
/** A phone-like run anywhere inside a string. */
const PHONE_RUN_RE = /\+?\d[\d\s-]{6,}\d/g;

/** "1800-419-5860" → "18004195860", "+91 70000 00009" → "+917000000009". */
const compactPhone = (phone: string): string => phone.replace(/[\s-]/g, "");

/**
 * Swaps the phone numbers in one topic's strings for {{PHONE:<key>}} tokens and records them in `phones`.
 * A field whose whole value is a number is keyed `<topic>_<field>` (`<topic>_<field>_<lang>` when a
 * translation holds a different number). The n-th distinct number embedded in the topic's text is keyed
 * `<topic>_<n>`; the same number in another language reuses its key.
 */
function phoneTokenizer(topic: string, phones: Record<string, string>) {
  const embedded = new Map<string, string>();
  const text = (value: string): string =>
    value.replace(PHONE_RUN_RE, (run) => {
      const phone = compactPhone(run);
      let key = embedded.get(phone);
      if (key === undefined) {
        key = `${topic}_${embedded.size + 1}`;
        embedded.set(phone, key);
        phones[key] = phone;
      }
      return `{{PHONE:${key}}}`;
    });
  const field = (value: string, name: string, lang: Language): string => {
    if (!PHONE_RE.test(value.trim())) return text(value);
    const phone = compactPhone(value);
    const shared = `${topic}_${name}`;
    const key = phones[shared] === undefined || phones[shared] === phone ? shared : `${shared}_${lang}`;
    phones[key] = phone;
    return `{{PHONE:${key}}}`;
  };
  return { text, field };
}

/**
 * Tokenizes every string of every topic in every language once, at load, so no lookup can return
 * phone digits and the registry is complete before the first lookup. English is scanned first, so
 * it sets the numbering. Only scanned topics are copied into the result, so a topic missing here
 * comes back empty rather than raw.
 */
function tokenizeContent(source: Record<string, unknown>): { content: Record<string, unknown>; phones: Record<string, string> } {
  const phones: Record<string, string> = {};
  const content: Record<string, unknown> = {};

  for (const topic of ["donate", "volunteer"]) {
    const t = phoneTokenizer(topic, phones);
    const node = (source[topic] ?? {}) as Record<string, unknown>;
    const out: Record<string, Record<string, unknown>> = {};
    for (const lang of LANGUAGES) {
      const fields = node[lang];
      if (typeof fields !== "object" || fields === null) continue;
      out[lang] = Object.fromEntries(
        Object.entries(fields).map(([name, value]) => [name, typeof value === "string" ? t.field(value, name, lang) : value]),
      );
    }
    content[topic] = out;
  }

  for (const topic of ["about", "human_emergency"]) {
    const t = phoneTokenizer(topic, phones);
    const node = (source[topic] ?? {}) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const lang of LANGUAGES) {
      const value = node[lang];
      if (typeof value === "string") out[lang] = t.text(value);
    }
    content[topic] = out;
  }

  const faq = phoneTokenizer("faq", phones);
  const entries = ((source.faq ?? []) as Record<string, unknown>[]).map((e) => ({ ...e }));
  for (const lang of LANGUAGES) {
    for (const e of entries) {
      for (const k of [`q_${lang}`, `a_${lang}`]) {
        const value = e[k];
        if (typeof value === "string") e[k] = faq.text(value);
      }
    }
  }
  content.faq = entries;

  return { content, phones };
}

const { content, phones: phoneRegistry } = tokenizeContent(raw as unknown as Record<string, unknown>);

/** Every phone in the content, keyed by token name; complete from module load. */
export function getStaticPhones(): Record<string, string> {
  return { ...phoneRegistry };
}

function localizedObject(topic: string, lang: Language): Record<string, string> {
  const node = (content[topic] ?? {}) as Localized;
  const en = (typeof node.en === "object" ? node.en : {}) as Record<string, string>;
  const target = (typeof node[lang] === "object" ? node[lang] : {}) as Record<string, string>;
  const out: Record<string, string> = {};
  for (const key of new Set([...Object.keys(en), ...Object.keys(target)])) {
    const v = isFilled(target[key]) ? target[key] : isFilled(en[key]) ? en[key] : undefined;
    if (v !== undefined) out[key] = v;
  }
  return out;
}

function localizedString(topic: string, lang: Language): string {
  const node = (content[topic] ?? {}) as Record<string, string>;
  return isFilled(node[lang]) ? node[lang] : isFilled(node.en) ? node.en : "";
}

export function getStaticInfo(topic: InfoTopic, lang: Language): InfoContent {
  switch (topic) {
    case "donate":
    case "volunteer":
      return localizedObject(topic, lang);
    case "about":
      return { text: localizedString("about", lang) };
    case "human_emergency":
      return { text: localizedString("human_emergency", lang) };
    case "faq": {
      const list = (content.faq ?? []) as Record<string, string>[];
      return {
        faq: list.map((e) => ({
          question: isFilled(e[`q_${lang}`]) ? e[`q_${lang}`] : e.q_en,
          answer: isFilled(e[`a_${lang}`]) ? e[`a_${lang}`] : e.a_en,
        })),
      };
    }
    case "helpline":
      return {
        phone: "{{PHONE:helpline}}",
        note: localizedString("about", lang),
      };
  }
}
