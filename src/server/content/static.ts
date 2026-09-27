import raw from "@/content/static.json";
import { LANGUAGES, type Language } from "../types";
import { PHONE_RUN_RE } from "../digits";

export type InfoTopic = "donate" | "volunteer" | "about" | "faq" | "human_emergency" | "helpline";
export type InfoContent = Record<string, string | { question: string; answer: string }[]>;

type Localized = Record<string, Record<string, string> | string>;

const isFilled = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0 && !v.trim().toUpperCase().startsWith("TODO");
/** A field whose whole value is one phone number: 7+ digits, at most one space or hyphen between two digits. */
const PHONE_RE = /^\+?\d(?:[ -]?\d){6,}$/;

/**
 * Maps Devanagari (U+0966–096F) and Gujarati (U+0AE6–0AEF) numerals to ASCII 0–9. Each numeral is one
 * UTF-16 unit, like its replacement, so every index in the result matches the input.
 */
export function foldDigits(s: string): string {
  return s.replace(/[\u0966-\u096F\u0AE6-\u0AEF]/g, (c) => {
    const code = c.charCodeAt(0);
    return String(code - (code >= 0x0ae6 ? 0x0ae6 : 0x0966));
  });
}

/** "1800-419-5860" → "18004195860", "+91 70000 00009" → "+917000000009". */
const compactPhone = (phone: string): string => phone.replace(/[\s-]/g, "");

/**
 * A donate or volunteer field whose number is a phone to hand over (contact_phone, helpline_number, whatsapp, …). A
 * number in any other field (bank, upi, summary) is not tokenized: it passes through, and the tool-boundary scrub
 * removes it before the model sees it, so an account number, IFSC or digit UPI id never goes out as a phone number.
 */
const PHONE_FIELD_RE = /phone|contact|mobile|helpline|whatsapp|number/i;
/** A field named for a bank or UPI detail is never a phone, even one also named for a number ("bank_account_number"). */
const NOT_PHONE_FIELD_RE = /account|ifsc|upi|bank/i;
const isPhoneField = (name: string): boolean => PHONE_FIELD_RE.test(name) && !NOT_PHONE_FIELD_RE.test(name);

/**
 * Swaps the phone numbers in one topic's strings for {{PHONE:<key>}} tokens and records them, as ASCII
 * digits, in `phones`. Native numerals are folded before matching; the text around a number is kept as
 * written. A field whose whole value is a number is keyed `<topic>_<field>` (`<topic>_<field>_<lang>` when a
 * translation holds a different number). The n-th distinct number embedded in the topic's text is keyed
 * `<topic>_<n>`; the same number in another language reuses its key.
 */
function phoneTokenizer(topic: string, phones: Record<string, string>) {
  const embedded = new Map<string, string>();
  const embeddedKey = (phone: string): string => {
    let key = embedded.get(phone);
    if (key === undefined) {
      key = `${topic}_${embedded.size + 1}`;
      embedded.set(phone, key);
      phones[key] = phone;
    }
    return key;
  };
  const text = (value: string): string => {
    let out = "";
    let last = 0;
    // PHONE_RUN_RE over foldDigits output, so native numerals count; it never runs across a line break or a spaced hyphen.
    for (const m of foldDigits(value).matchAll(PHONE_RUN_RE)) {
      out += `${value.slice(last, m.index)}{{PHONE:${embeddedKey(compactPhone(m[0]))}}}`;
      last = m.index + m[0].length;
    }
    return out + value.slice(last);
  };
  const field = (value: string, name: string, lang: Language): string => {
    const folded = foldDigits(value).trim();
    if (!PHONE_RE.test(folded)) return text(value);
    const phone = compactPhone(folded);
    const shared = `${topic}_${name}`;
    const key = phones[shared] === undefined || phones[shared] === phone ? shared : `${shared}_${lang}`;
    phones[key] = phone;
    return `{{PHONE:${key}}}`;
  };
  return { text, field };
}

/**
 * Tokenizes the phone numbers of every topic in every language once, at load, so the registry is complete before the
 * first lookup: in donate and volunteer only the fields isPhoneField names (the rest pass through, for the tool
 * boundary's scrub); in the free text of about, human_emergency and the FAQ, every 7+ digit run (so only phone
 * numbers belong there). English is scanned first, so it sets the numbering. Only scanned topics are copied into the
 * result, so a topic missing here comes back empty rather than raw.
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
        Object.entries(fields).map(([name, value]) => [
          name,
          typeof value === "string" && isPhoneField(name) ? t.field(value, name, lang) : value,
        ]),
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

/** The value in the requested language when filled, else the English one when filled, else nothing. */
function pick(localized: unknown, english: unknown): string | undefined {
  return isFilled(localized) ? localized : isFilled(english) ? english : undefined;
}

function localizedObject(topic: string, lang: Language): Record<string, string> {
  const node = (content[topic] ?? {}) as Localized;
  const en = (typeof node.en === "object" ? node.en : {}) as Record<string, string>;
  const target = (typeof node[lang] === "object" ? node[lang] : {}) as Record<string, string>;
  const out: Record<string, string> = {};
  for (const key of new Set([...Object.keys(en), ...Object.keys(target)])) {
    const v = pick(target[key], en[key]);
    if (v !== undefined) out[key] = v;
  }
  return out;
}

function localizedString(topic: string, lang: Language): string | undefined {
  const node = (content[topic] ?? {}) as Record<string, string>;
  return pick(node[lang], node.en);
}

/** `{ [name]: value }`, or `{}` when nothing is filled. */
const optionalField = (name: string, value: string | undefined): Record<string, string> => (value === undefined ? {} : { [name]: value });

export function getStaticInfo(topic: InfoTopic, lang: Language): InfoContent {
  switch (topic) {
    case "donate":
    case "volunteer":
      return localizedObject(topic, lang);
    case "about":
    case "human_emergency":
      return optionalField("text", localizedString(topic, lang));
    case "faq": {
      const list = (content.faq ?? []) as Record<string, string>[];
      const faq: { question: string; answer: string }[] = [];
      for (const e of list) {
        const question = pick(e[`q_${lang}`], e.q_en);
        const answer = pick(e[`a_${lang}`], e.a_en);
        if (question !== undefined && answer !== undefined) faq.push({ question, answer });
      }
      return { faq };
    }
    case "helpline":
      return { phone: "{{PHONE:helpline}}", ...optionalField("note", localizedString("about", lang)) };
  }
}
