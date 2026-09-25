/**
 * Deterministic welcome message — the first thing every reporter sees.
 *
 * Sent synchronously on first inbound (status='new', no prior assistant
 * messages). Sets up the helpline experience with a multi-intent menu.
 *
 * Multilingual but uses Indic-friendly "Namaste" greeting in all languages
 * and includes the project URL.
 */
import type { Language } from "../types";

const WEBSITE = "https://alwayscare.org";

const WELCOME_BY_LANG: Record<Language, string> = {
  en: `Namaste! 🙏 Thank you for texting Arham Always Care helpline.

How may I assist you today?

🚑  *Animal ambulance* — for an injured or sick stray animal
💝  *Donate* — support free animal rescue
🤝  *Volunteer* — join our team
🏥  *Clinic info* — find a clinic near you
✉️  *Suggestion* — share feedback

Just reply with what you need (e.g. "ambulance", "donate"), or visit ${WEBSITE}`,

  hi: `नमस्ते! 🙏 Arham Always Care हेल्पलाइन को संदेश भेजने के लिए धन्यवाद।

मैं आपकी कैसे मदद कर सकता हूँ?

🚑  *एनिमल एम्बुलेंस* — घायल या बीमार जानवर के लिए
💝  *दान* — मुफ़्त पशु बचाव में सहयोग
🤝  *वालंटियर* — हमारी टीम से जुड़ें
🏥  *क्लिनिक जानकारी* — अपने पास का क्लिनिक खोजें
✉️  *सुझाव* — फ़ीडबैक भेजें

बस जो चाहिए वो लिख दीजिए, या ${WEBSITE} देखें।`,

  mr: `नमस्कार! 🙏 Arham Always Care हेल्पलाइनला संदेश पाठवल्याबद्दल धन्यवाद.

मी तुम्हाला कशी मदत करू शकतो?

🚑  *एनिमल एम्बुलन्स* — जखमी किंवा आजारी प्राण्यासाठी
💝  *दान* — मोफत प्राणी बचावासाठी मदत
🤝  *स्वयंसेवक* — आमच्या टीमसोबत सामील व्हा
🏥  *क्लिनिक माहिती* — जवळचे क्लिनिक शोधा
✉️  *सूचना* — अभिप्राय शेअर करा

तुम्हाला काय हवे ते लिहा, किंवा ${WEBSITE} पहा.`,

  gu: `નમસ્તે! 🙏 Arham Always Care હેલ્પલાઇનને સંદેશ મોકલવા બદલ આભાર.

હું તમને કેવી રીતે મદદ કરી શકું?

🚑  *એનિમલ એમ્બ્યુલન્સ* — ઘાયલ અથવા બીમાર પ્રાણી માટે
💝  *દાન* — મફત પ્રાણી બચાવમાં સહયોગ
🤝  *સ્વયંસેવક* — અમારી ટીમમાં જોડાઓ
🏥  *ક્લિનિક માહિતી* — નજીકનું ક્લિનિક શોધો
✉️  *સૂચન* — પ્રતિસાદ આપો

જે જોઈતું હોય તે લખો, અથવા ${WEBSITE} જુઓ.`,
};

export function welcomeMessage(language: Language = "en"): string {
  return WELCOME_BY_LANG[language] ?? WELCOME_BY_LANG.en;
}

/** Re-display the menu when the reporter asks for it later. Slightly shorter version. */
const MENU_BY_LANG: Record<Language, string> = {
  en: `How can we help?

🚑  *Animal ambulance*
💝  *Donate*
🤝  *Volunteer*
🏥  *Clinic info*
✉️  *Suggestion*

Reply with the option, or visit ${WEBSITE}`,

  hi: `हम आपकी कैसे मदद करें?

🚑  *एनिमल एम्बुलेंस*
💝  *दान*
🤝  *वालंटियर*
🏥  *क्लिनिक जानकारी*
✉️  *सुझाव*

विकल्प लिखें, या ${WEBSITE} देखें।`,

  mr: `आम्ही कशी मदत करू?

🚑  *एनिमल एम्बुलन्स*
💝  *दान*
🤝  *स्वयंसेवक*
🏥  *क्लिनिक माहिती*
✉️  *सूचना*

पर्याय लिहा, किंवा ${WEBSITE} पहा.`,

  gu: `અમે કેવી રીતે મદદ કરી શકીએ?

🚑  *એનિમલ એમ્બ્યુલન્સ*
💝  *દાન*
🤝  *સ્વયંસેવક*
🏥  *ક્લિનિક માહિતી*
✉️  *સૂચન*

વિકલ્પ લખો, અથવા ${WEBSITE} જુઓ.`,
};

export function menuMessage(language: Language = "en"): string {
  return MENU_BY_LANG[language] ?? MENU_BY_LANG.en;
}
