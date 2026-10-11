import type { Language } from "./types";

const SCRIPT_START = "(?:^|[\\s।,.!?;:\"'(\\[{])";
const SCRIPT_END = "(?:$|[\\s।,.!?;:\"')\\]}])";

/** Marathi words, and verb stems whose endings vary (बघितला, पाहिलं, करायचे: a vowel sign, then an optional anusvara). */
const MARATHI_RE = new RegExp(
  `${SCRIPT_START}(?:आहे|आहेत|आहोत|नाही|काय|कुठे|कुत्रा|जखमी|मांजर|(?:बघितल|पाहिल|करायच)[\u093E-\u094C]?[\u0901\u0902]?)${SCRIPT_END}`
);

/** Any character of the Devanagari block (U+0900–U+097F), and of the Gujarati block (U+0A80–U+0AFF). */
const DEVANAGARI_RE = /[\u0900-\u097F]/;
const GUJARATI_RE = /[\u0A80-\u0AFF]/;

/**
 * By script: Devanagari is Marathi when it holds a Marathi marker, else Hindi; Gujarati script is Gujarati; anything
 * else is English, Latin-script Hinglish included ("kutta ghayal hai"), so the system's own lines go out in English
 * for it, as Claude reports the language for such a reporter.
 */
export function detectLanguage(text: string): Language {
  if (!text) return "en";
  if (DEVANAGARI_RE.test(text)) return MARATHI_RE.test(text) ? "mr" : "hi";
  if (GUJARATI_RE.test(text)) return "gu";
  return "en";
}

/**
 * The language of the system's own lines (partner labels, cards, the call-directly line) for a reply Claude labelled
 * `label`: the reply's script decides, not the label. A reply labelled hi or mr that holds no Devanagari character, or
 * gu with no Gujarati one, is not written in that script (Latin-script Hinglish, which the model sometimes labels hi),
 * so its lines go out in English. Never the other way: a label that matches the reply's script stands, a Devanagari
 * reply labelled en keeps en, and hi against mr stays Claude's call.
 */
export function languageForScript(label: Language, reply: string): Language {
  if ((label === "hi" || label === "mr") && !DEVANAGARI_RE.test(reply)) return "en";
  if (label === "gu" && !GUJARATI_RE.test(reply)) return "en";
  return label;
}

const MENU_WORDS = /^(menu|options?|help|sahaay|मेन्यू|पर्याय|मेनू|menyu|મેનુ|પર્યાય|વિકલ્પ)$/i;

/** The text as the word checks read it: emoji and punctuation as spaces, spaces collapsed, lower case. */
function cleanWords(text: string): string {
  return (text ?? "")
    // Not \p{Emoji_Component}: it includes 0-9, # and *, and a pincode is content, not noise.
    .replace(/[\p{Extended_Pictographic}\u200d\ufe0e\ufe0f\u20e3]/gu, " ")
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** A menu request alone ("menu", "Menu?", "मेनू।"), whatever punctuation or emoji surround it. */
export function isMenuWord(text: string): boolean {
  return MENU_WORDS.test(cleanWords(text));
}

const GREETING_WORDS = /^(hi+|hello+|hey+|hii+|helo|namaste|namaskar|namaskaram|नमस्ते|नमस्कार|નમસ્તે|નમસ્કાર|ok|okay|thanks?|there|ji|hai)$/i;

/** Multi-word greetings, matched against the whole cleaned message before the per-word check. */
const GREETING_PHRASES = new Set(["good morning", "good afternoon", "good evening", "thank you", "thanks a lot", "ok thanks"]);

/** True when the text carries no request: greetings, punctuation, emoji, menu words, empty. Digits are always content. */
export function isGreetingOnly(text: string): boolean {
  const cleaned = cleanWords(text);
  if (cleaned.length === 0) return true;
  if (isMenuWord(cleaned)) return true;
  if (GREETING_PHRASES.has(cleaned)) return true;
  return cleaned.split(" ").every((w) => GREETING_WORDS.test(w));
}
