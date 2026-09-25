import type { Language } from "./types";

const SCRIPT_START = "(?:^|[\\s।,.!?;:\"'(\\[{])";
const SCRIPT_END = "(?:$|[\\s।,.!?;:\"')\\]}])";

/** Script-based detection with a small Hinglish keyword list. Defaults to English. */
export function detectLanguage(text: string): Language {
  if (!text) return "en";
  if (/[ऀ-ॿ]/.test(text)) {
    const marathi = new RegExp(`${SCRIPT_START}(आहे|आहेत|आहोत|नाही|काय|कुठे|कुत्रा|जखमी|मांजर|बघितल|पाहिल|करायच)${SCRIPT_END}`);
    return marathi.test(text) ? "mr" : "hi";
  }
  if (/[઀-૿]/.test(text)) return "gu";
  const hinglish = /\b(hai|hain|kaise|kaha|kahaan|kya|nahi|nahin|theek|jald|jaldi|krpya|kripaya|madad|ghayal|jakhmi|kutta|billi|janwar|bhai|bhaiya|didi|aap|hum|tum)\b/i;
  return hinglish.test(text) ? "hi" : "en";
}

const MENU_WORDS = /^(menu|options?|help|sahaay|मेन्यू|पर्याय|मेनू|menyu|મેનુ|પર્યાય|વિકલ્પ)$/i;

export function isMenuWord(text: string): boolean {
  return MENU_WORDS.test((text ?? "").trim());
}

const GREETING_WORDS = /^(hi+|hello+|hey+|hii+|helo|namaste|namaskar|namaskaram|नमस्ते|नमस्कार|નમસ્તે|નમસ્કાર|good (morning|afternoon|evening)|ok|okay|thanks?|thank you|there|ji|hai)$/i;

/** True when the text carries no request: greetings, punctuation, emoji, menu words, empty. */
export function isGreetingOnly(text: string): boolean {
  const cleaned = (text ?? "")
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Component}‍️]/gu, " ")
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (cleaned.length === 0) return true;
  if (isMenuWord(cleaned)) return true;
  return cleaned.split(" ").every((w) => GREETING_WORDS.test(w));
}
