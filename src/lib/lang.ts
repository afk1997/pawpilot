/**
 * Lightweight language detection + multilingual regex helpers.
 *
 * V1 supports: English, Hindi (Devanagari + Hinglish), Marathi, Gujarati.
 * Detection is deliberately simple — script-based with a small Hinglish
 * keyword list. The system prompt also instructs the LLM to detect and
 * respond in the reporter's language; this util is for hardcoded rails
 * (escalation triggers, manual-override detection) where we don't want to
 * pay a model round-trip.
 */
import type { Language } from "./types";

/** Detect the most likely language of a message. Defaults to "en". */
export function detectLanguage(text: string): Language {
  if (!text) return "en";
  // Devanagari (Hindi + Marathi share the script).
  if (/[ऀ-ॿ]/.test(text)) {
    // Marathi-specific markers
    if (/\b(आहे|कर|काय|कुठे|कुत्रा|जखमी|मांजर)\b/.test(text)) return "mr";
    return "hi";
  }
  // Gujarati
  if (/[઀-૿]/.test(text)) return "gu";

  // Hinglish: English script but Hindi keywords. Treat as "hi" so we reply
  // in Hindi if the LLM detects intent (unless prompt says match the script).
  const hinglishKeywords = /\b(hai|hain|kaise|kaha|kahaan|kya|nahi|nahin|theek|jald|jaldi|krpya|kripaya|madad|ghayal|jakhmi|kutta|billi|gaay|janwar|ambulance)\b/i;
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
  // English
  /\b(can'?t|cannot|couldn'?t|could not|unable to|no one|nobody|no answer|not picking|not picked|didn'?t pick|didn'?t answer|no response|not responding|busy|unreachable|switched off)\b/i,
  /\b(no reply|not replying|doesn'?t reply|isn'?t answering|won'?t pick)\b/i,
  // Hinglish
  /\b(nahi (utha|uthaya|utha rahe)|phone nahi|reply nahi|jawab nahi|busy hai|switch off|nahi mil|nahi laga|engaged hai|number nahi lag)\b/i,
  // Devanagari (Hindi)
  /(नहीं उठा|नहीं उठाया|जवाब नहीं|बंद है|कॉल नहीं लग|फोन बंद|नहीं मिल रहा)/,
  // Marathi
  /(उचलला नाही|प्रतिसाद नाही|बंद आहे|उत्तर नाही|फोन लागत नाही)/,
  // Gujarati
  /(ઉપાડ્યો નથી|જવાબ નથી|બંધ છે|ફોન લાગતો નથી)/,
];

export function isCannotReachMessage(text: string): boolean {
  if (!text) return false;
  return CANNOT_REACH_PATTERNS.some((re) => re.test(text));
}

/**
 * Reporter wants a human dispatcher.
 */
const HUMAN_HANDOFF_PATTERNS: RegExp[] = [
  /\b(human|agent|operator|representative|person|talk to (a |someone|person|human))\b/i,
  /\b(connect (me )?to (someone|human|person|operator))\b/i,
  // Hinglish
  /\b(insaan|asli aadmi|asli person|sachcha|kisi se baat|operator se|admin se)\b/i,
  // Hindi
  /(किसी से बात|इंसान से बात|ऑपरेटर|प्रतिनिधि)/,
  // Marathi
  /(माणसाशी बोल|प्रतिनिधी)/,
  // Gujarati
  /(માણસ સાથે વાત|પ્રતિનિધિ)/,
];

export function isHumanHandoffRequest(text: string): boolean {
  if (!text) return false;
  return HUMAN_HANDOFF_PATTERNS.some((re) => re.test(text));
}
