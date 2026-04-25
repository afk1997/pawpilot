import staticContent from "@/content/static.json";

export type Language = "en" | "hi" | "mr" | "gu";

export type StaticTopic = "donate" | "volunteer" | "about" | "faq" | "human_emergency_referral";

/**
 * Get a localized snippet for a given topic. Falls back to English if the
 * requested language isn't filled in yet (during V1 rollout, languages are
 * filled incrementally).
 *
 * Clinic info is NOT here — fetch from the `clinics` DB table at runtime.
 */
export function getStaticContent(topic: StaticTopic, language: Language = "en"): unknown {
  const node = (staticContent as Record<string, unknown>)[topic];
  if (!node) return null;

  // FAQ is an array of multilingual Q&A pairs.
  if (topic === "faq" && Array.isArray(node)) {
    return node.map((entry) => {
      const e = entry as Record<string, string>;
      const q = e[`q_${language}`] && !e[`q_${language}`].startsWith("TODO") ? e[`q_${language}`] : e.q_en;
      const a = e[`a_${language}`] && !e[`a_${language}`].startsWith("TODO") ? e[`a_${language}`] : e.a_en;
      return { question: q, answer: a };
    });
  }

  // human_emergency_referral and about are { lang: string }.
  if (typeof node === "object" && node !== null && !Array.isArray(node)) {
    const obj = node as Record<string, unknown>;
    const value = obj[language];
    if (typeof value === "string" && !value.startsWith("TODO")) return value;
    if (typeof obj.en === "string") return obj.en;
    return obj;
  }

  return node;
}
