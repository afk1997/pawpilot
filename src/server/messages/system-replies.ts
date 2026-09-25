import type { Language } from "../types";

const pick = (m: Record<Language, string>, lang: Language) => m[lang] ?? m.en;

export function audioNotSupported(lang: Language): string {
  return pick({
    en: "Sorry, I can't listen to voice notes yet. Please type your message and I'll help right away.",
    hi: "माफ़ कीजिए, मैं अभी वॉइस नोट नहीं सुन सकता। कृपया अपना संदेश लिखकर भेजें, मैं तुरंत मदद करूँगा।",
    mr: "क्षमस्व, मी अजून व्हॉइस नोट ऐकू शकत नाही. कृपया तुमचा संदेश लिहून पाठवा, मी लगेच मदत करेन.",
    gu: "માફ કરશો, હું હજી વૉઇસ નોટ સાંભળી શકતો નથી. કૃપા કરીને તમારો સંદેશ લખીને મોકલો, હું તરત મદદ કરીશ.",
  }, lang);
}

/** First line of a fallback reply when the directory matched. */
export function fallbackFoundIntro(lang: Language): string {
  return pick({
    en: "Here is the animal ambulance for your area:",
    hi: "आपके इलाके की एनिमल एम्बुलेंस यह रही:",
    mr: "तुमच्या भागातील एनिमल एम्बुलन्स ही आहे:",
    gu: "તમારા વિસ્તારની એનિમલ એમ્બ્યુલન્સ આ રહી:",
  }, lang);
}

/** First line of a fallback reply when nothing matched. */
export function fallbackNoMatch(lang: Language): string {
  return pick({
    en: "I couldn't find that area right now.",
    hi: "मुझे अभी वह इलाका नहीं मिल पाया।",
    mr: "मला आत्ता तो भाग सापडला नाही.",
    gu: "મને હાલ તે વિસ્તાર મળ્યો નહીં.",
  }, lang);
}

/** Replacement for a sentence that contained dispatch language. */
export function callDirectlyLine(lang: Language): string {
  return pick({
    en: "Please call them directly and they will guide you.",
    hi: "कृपया उन्हें सीधे कॉल करें, वे आपका मार्गदर्शन करेंगे।",
    mr: "कृपया त्यांना थेट कॉल करा, ते तुम्हाला मार्गदर्शन करतील.",
    gu: "કૃપા કરીને તેમને સીધો કૉલ કરો, તેઓ તમને માર્ગદર્શન આપશે.",
  }, lang);
}

export const TOKEN_CORRECTION_NOTE =
  "SYSTEM CORRECTION: your previous draft typed a phone number as digits. Phone numbers may only appear as tokens: {{AMB:<handle>}}, {{CLINIC:<handle>}}, or any {{PHONE:<key>}} token exactly as a tool returned it (including {{PHONE:helpline}}). Rewrite the reply using tokens only.";

export const DISPATCH_CORRECTION_NOTE =
  "SYSTEM CORRECTION: your previous draft implied that Arham sends or dispatches the ambulance. We never dispatch; the reporter calls the driver directly. Rewrite the reply without any sending/dispatching/on-the-way language.";
