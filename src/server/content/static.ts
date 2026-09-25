import raw from "@/content/static.json";
import type { Language } from "../types";

export type InfoTopic = "donate" | "volunteer" | "about" | "faq" | "human_emergency" | "helpline";
export type InfoContent = Record<string, string | { question: string; answer: string }[]>;

type Localized = Record<string, Record<string, string> | string>;
const content = raw as unknown as Record<string, unknown>;

const isFilled = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0 && !v.trim().toUpperCase().startsWith("TODO");
const PHONE_RE = /^\+?\d[\d\s-]{6,}\d$/;

/** Real phones found in content, keyed by token name; filled lazily. */
const phoneRegistry: Record<string, string> = {};

export function getStaticPhones(): Record<string, string> {
  getStaticInfo("volunteer", "en");
  return { ...phoneRegistry };
}

function localizedObject(topic: string, lang: Language): Record<string, string> {
  const node = (content[topic] ?? {}) as Localized;
  const en = (typeof node.en === "object" ? node.en : {}) as Record<string, string>;
  const target = (typeof node[lang] === "object" ? node[lang] : {}) as Record<string, string>;
  const out: Record<string, string> = {};
  for (const key of new Set([...Object.keys(en), ...Object.keys(target)])) {
    const v = isFilled(target[key]) ? target[key] : isFilled(en[key]) ? en[key] : undefined;
    if (v === undefined) continue;
    if (key.includes("phone") && PHONE_RE.test(v)) {
      const tokenName = `${topic}`;
      phoneRegistry[tokenName] = v.replace(/[\s-]/g, "");
      out[key] = `{{PHONE:${tokenName}}}`;
    } else {
      out[key] = v;
    }
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
