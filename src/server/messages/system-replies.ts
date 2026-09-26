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

/** First line of a fallback reply when the directory matched; `count > 1` gives the plural form for the multi-card. */
export function fallbackFoundIntro(lang: Language, count = 1): string {
  if (count > 1) {
    return pick({
      en: "Here are the animal ambulances for your area:",
      hi: "आपके इलाके की एनिमल एम्बुलेंस ये रहीं:",
      mr: "तुमच्या भागातील एनिमल एम्बुलन्स या आहेत:",
      gu: "તમારા વિસ્તારની એનિમલ એમ્બ્યુલન્સ આ રહી:",
    }, lang);
  }
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

/** First line of a fallback reply when the place was found but has more units than a card lists. */
export function fallbackHelplineIntro(lang: Language): string {
  return pick({
    en: "Please call our helpline:",
    hi: "कृपया हमारी हेल्पलाइन पर कॉल करें:",
    mr: "कृपया आमच्या हेल्पलाइनवर कॉल करा:",
    gu: "કૃપા કરીને અમારી હેલ્પલાઇન પર કૉલ કરો:",
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

/** A handle as makeHandle writes it (letters a to p only): the only form a correction may name, so it never holds a digit. */
const HANDLE_RE = /^(?:amb|cli)_[a-p]{8}$/;

/**
 * The correction for a draft that used the handles of units or clinics no longer active. It names each handle with the
 * tool that finds a current one (find_ambulances for amb_, find_clinics for cli_), without TOKEN_CORRECTION_NOTE's
 * wording about typed digits. Values that are not handle-shaped are left out.
 */
export function staleHandleNote(handles: string[]): string {
  const named = [...new Set(handles.map((h) => h.toLowerCase()))].filter((h) => HANDLE_RE.test(h));
  const units = named.filter((h) => h.startsWith("amb_"));
  const clinics = named.filter((h) => h.startsWith("cli_"));
  const parts: string[] = [];
  if (units.length > 0) parts.push(`${units.join(", ")} (${units.length === 1 ? "an ambulance that is" : "ambulances that are"} no longer available): call find_ambulances again for the reporter's place`);
  if (clinics.length > 0) parts.push(`${clinics.join(", ")} (${clinics.length === 1 ? "a clinic that is" : "clinics that are"} no longer available): call find_clinics again`);
  if (parts.length === 0) parts.push("a unit or clinic in it is no longer available: look it up again with find_ambulances or find_clinics");
  return `SYSTEM CORRECTION: your previous draft used a handle that no longer works. ${parts.join("; ")}. Use only handles the new result returns.`;
}

export const DISPATCH_CORRECTION_NOTE =
  "SYSTEM CORRECTION: your previous draft implied that Arham sends or dispatches the ambulance. We never dispatch; the reporter calls the driver directly. Rewrite the reply without any sending/dispatching/on-the-way language.";
