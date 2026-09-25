/**
 * Lightweight language detection + multilingual regex helpers.
 *
 * V1 supports: English, Hindi (Devanagari + Hinglish), Marathi, Gujarati.
 * Detection is deliberately simple — script-based with a small Hinglish
 * keyword list. The system prompt also instructs the LLM to detect and
 * respond in the reporter's language; this util is for hardcoded rails
 * (escalation triggers, manual-override detection) where we don't want to
 * pay a model round-trip.
 *
 * IMPORTANT: ECMAScript `\b` is ASCII-only — it does NOT fire between
 * Devanagari/Gujarati letters and spaces. We use explicit lookbehind /
 * lookahead boundaries on Indic patterns so they actually match.
 */
import type { Language } from "./types";

// "Word" boundary that works for Devanagari + Gujarati. Use in patterns that
// must match Indic-script substrings.
const SCRIPT_START = "(?:^|[\\s।,.!?;:\"'(\\[{])";
const SCRIPT_END = "(?:$|[\\s।,.!?;:\"')\\]}])";

/** Detect the most likely language of a message. Defaults to "en". */
export function detectLanguage(text: string): Language {
  if (!text) return "en";

  // Devanagari (Hindi + Marathi share the script).
  if (/[ऀ-ॿ]/.test(text)) {
    // Marathi-specific markers — copula `आहे`, `आहेत`, common verbs/markers
    // that are NOT shared with Hindi. NO `\b` (broken on Devanagari).
    const marathi = new RegExp(
      `${SCRIPT_START}(आहे|आहेत|आहोत|नाही|काय|कुठे|कुत्रा|जखमी|मांजर|बघितल|पाहिल|करायच)${SCRIPT_END}`
    );
    if (marathi.test(text)) return "mr";
    return "hi";
  }

  // Gujarati
  if (/[઀-૿]/.test(text)) return "gu";

  // Hinglish: English script but Hindi keywords. NOTE: words shared with
  // English (like "ambulance") would falsely trigger Hindi — those are
  // explicitly excluded.
  const hinglishKeywords =
    /\b(hai|hain|kaise|kaha|kahaan|kya|nahi|nahin|theek|jald|jaldi|krpya|kripaya|madad|ghayal|jakhmi|kutta|billi|janwar|bhai|bhaiya|didi|aap|hum|tum)\b/i;
  if (hinglishKeywords.test(text)) return "hi";

  return "en";
}

// ---------------------------------------------------------------------------
// Hardcoded rails — multilingual regex.
// ---------------------------------------------------------------------------

/**
 * Reporter says "couldn't reach driver" / "not picking up" — auto-escalate.
 */
const CANNOT_REACH_PATTERNS: RegExp[] = [
  // English — generous, but bounded by spaces / punctuation.
  /\b(can'?t|cannot|couldn'?t|could not|unable to)\s+(reach|connect|call|get)\b/i,
  /\b(no one|nobody|no answer|not picking|not picked|didn'?t pick|didn'?t answer|no response|not responding|busy|unreachable|switched off)\b/i,
  /\b(no reply|not replying|doesn'?t reply|isn'?t answering|won'?t pick|won'?t answer)\b/i,

  // Hinglish — same approach, ASCII so `\b` is fine.
  /\b(nahi (utha|uthaya|utha rahe|laga|lag raha|le rahe))\b/i,
  /\b(phone nahi (lag|laga|utha|le)|reply nahi|jawab nahi|busy hai|switch off|engaged hai|number nahi lag)\b/i,

  // Devanagari — script-aware boundaries.
  new RegExp(
    `${SCRIPT_START}(नहीं उठा|नहीं उठाया|जवाब नहीं|बंद है|कॉल नहीं लग|फोन बंद|नहीं मिल रहा|बात नहीं हो)`
  ),

  // Marathi
  new RegExp(
    `${SCRIPT_START}(उचलला नाही|उचलत नाही|प्रतिसाद नाही|बंद आहे|उत्तर नाही|फोन लागत नाही|संपर्क झाला नाही)`
  ),

  // Gujarati
  new RegExp(
    `${SCRIPT_START}(ઉપાડ્યો નથી|ઉપાડતો નથી|જવાબ નથી|બંધ છે|ફોન લાગતો નથી|સંપર્ક થયો નથી)`
  ),
];

export function isCannotReachMessage(text: string): boolean {
  if (!text) return false;
  return CANNOT_REACH_PATTERNS.some((re) => re.test(text));
}

/**
 * Reporter wants a human dispatcher. Tight patterns to avoid matching
 * unrelated mentions of "person" (e.g. "an injured person was hit").
 */
const HUMAN_HANDOFF_PATTERNS: RegExp[] = [
  // Direct asks
  /\b(human|operator|representative)\b/i,
  /\b(talk to (a |an |someone|person|human|real person|real human|operator|someone real))\b/i,
  /\b(connect (me )?to (someone|human|person|operator|a human|a person))\b/i,
  /\b(speak (to|with) (a |an |someone|human|person|operator))\b/i,
  // "Agent" alone is too noisy — only match in handoff context.
  /\b(real|live|human)\s+(agent|support)\b/i,

  // Hinglish
  /\b(insaan|asli aadmi|asli person|sachcha|kisi se baat|operator se|admin se baat)\b/i,

  // Devanagari
  new RegExp(`${SCRIPT_START}(किसी से बात|इंसान से बात|ऑपरेटर|प्रतिनिधि|व्यक्ति से बात)`),

  // Marathi
  new RegExp(`${SCRIPT_START}(माणसाशी बोल|माणसाशी संपर्क|प्रतिनिधी)`),

  // Gujarati
  new RegExp(`${SCRIPT_START}(માણસ સાથે વાત|માણસનો સંપર્ક|પ્રતિનિધિ)`),
];

export function isHumanHandoffRequest(text: string): boolean {
  if (!text) return false;
  return HUMAN_HANDOFF_PATTERNS.some((re) => re.test(text));
}
