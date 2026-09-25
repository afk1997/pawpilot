import type { Language } from "../types";

export type MenuId = "menu:ambulance" | "menu:clinic" | "menu:donate" | "menu:volunteer" | "menu:suggestion";

const WELCOME_BY_LANG: Record<Language, (site: string) => string> = {
  en: (site) => `Namaste! 🙏 Thank you for texting Arham Always Care helpline.

How may I assist you today?

🚑  *Animal ambulance* — for an injured or sick stray animal
💝  *Donate* — support free animal rescue
🤝  *Volunteer* — join our team
🏥  *Clinic info* — find a clinic near you
✉️  *Suggestion* — share feedback

Just reply with what you need (e.g. "ambulance", "donate"), or visit ${site}`,
  hi: (site) => `नमस्ते! 🙏 Arham Always Care हेल्पलाइन को संदेश भेजने के लिए धन्यवाद।

मैं आपकी कैसे मदद कर सकता हूँ?

🚑  *एनिमल एम्बुलेंस* — घायल या बीमार जानवर के लिए
💝  *दान* — मुफ़्त पशु बचाव में सहयोग
🤝  *वालंटियर* — हमारी टीम से जुड़ें
🏥  *क्लिनिक जानकारी* — अपने पास का क्लिनिक खोजें
✉️  *सुझाव* — फ़ीडबैक भेजें

बस जो चाहिए वो लिख दीजिए, या ${site} देखें।`,
  mr: (site) => `नमस्कार! 🙏 Arham Always Care हेल्पलाइनला संदेश पाठवल्याबद्दल धन्यवाद.

मी तुम्हाला कशी मदत करू शकतो?

🚑  *एनिमल एम्बुलन्स* — जखमी किंवा आजारी प्राण्यासाठी
💝  *दान* — मोफत प्राणी बचावासाठी मदत
🤝  *स्वयंसेवक* — आमच्या टीमसोबत सामील व्हा
🏥  *क्लिनिक माहिती* — जवळचे क्लिनिक शोधा
✉️  *सूचना* — अभिप्राय शेअर करा

तुम्हाला काय हवे ते लिहा, किंवा ${site} पहा.`,
  gu: (site) => `નમસ્તે! 🙏 Arham Always Care હેલ્પલાઇનને સંદેશ મોકલવા બદલ આભાર.

હું તમને કેવી રીતે મદદ કરી શકું?

🚑  *એનિમલ એમ્બ્યુલન્સ* — ઘાયલ અથવા બીમાર પ્રાણી માટે
💝  *દાન* — મફત પ્રાણી બચાવમાં સહયોગ
🤝  *સ્વયંસેવક* — અમારી ટીમમાં જોડાઓ
🏥  *ક્લિનિક માહિતી* — નજીકનું ક્લિનિક શોધો
✉️  *સૂચન* — પ્રતિસાદ આપો

જે જોઈતું હોય તે લખો, અથવા ${site} જુઓ.`,
};

const MENU_BY_LANG: Record<Language, (site: string) => string> = {
  en: (site) => `How can we help?\n\n🚑  *Animal ambulance*\n💝  *Donate*\n🤝  *Volunteer*\n🏥  *Clinic info*\n✉️  *Suggestion*\n\nReply with the option, or visit ${site}`,
  hi: (site) => `हम आपकी कैसे मदद करें?\n\n🚑  *एनिमल एम्बुलेंस*\n💝  *दान*\n🤝  *वालंटियर*\n🏥  *क्लिनिक जानकारी*\n✉️  *सुझाव*\n\nविकल्प लिखें, या ${site} देखें।`,
  mr: (site) => `आम्ही कशी मदत करू?\n\n🚑  *एनिमल एम्बुलन्स*\n💝  *दान*\n🤝  *स्वयंसेवक*\n🏥  *क्लिनिक माहिती*\n✉️  *सूचना*\n\nपर्याय लिहा, किंवा ${site} पहा.`,
  gu: (site) => `અમે કેવી રીતે મદદ કરી શકીએ?\n\n🚑  *એનિમલ એમ્બ્યુલન્સ*\n💝  *દાન*\n🤝  *સ્વયંસેવક*\n🏥  *ક્લિનિક માહિતી*\n✉️  *સૂચન*\n\nવિકલ્પ લખો, અથવા ${site} જુઓ.`,
};

let site = "https://arhamalwayscare.org";
/** Called once at startup with config.websiteUrl. */
export function setWebsiteUrl(url: string): void {
  site = url;
}

export function welcomeText(lang: Language = "en"): string {
  return (WELCOME_BY_LANG[lang] ?? WELCOME_BY_LANG.en)(site);
}

export function menuText(lang: Language = "en"): string {
  return (MENU_BY_LANG[lang] ?? MENU_BY_LANG.en)(site);
}

/** WhatsApp list button label, max 20 chars. */
export const MENU_BUTTON_LABEL: Record<Language, string> = { en: "Options", hi: "विकल्प", mr: "पर्याय", gu: "વિકલ્પો" };

const ROW_TITLES: Record<Language, Record<MenuId, string>> = {
  en: { "menu:ambulance": "Animal ambulance", "menu:clinic": "Clinic info", "menu:donate": "Donate", "menu:volunteer": "Volunteer", "menu:suggestion": "Suggestion" },
  hi: { "menu:ambulance": "एनिमल एम्बुलेंस", "menu:clinic": "क्लिनिक जानकारी", "menu:donate": "दान", "menu:volunteer": "वालंटियर", "menu:suggestion": "सुझाव" },
  mr: { "menu:ambulance": "एनिमल एम्बुलन्स", "menu:clinic": "क्लिनिक माहिती", "menu:donate": "दान", "menu:volunteer": "स्वयंसेवक", "menu:suggestion": "सूचना" },
  gu: { "menu:ambulance": "એનિમલ એમ્બ્યુલન્સ", "menu:clinic": "ક્લિનિક માહિતી", "menu:donate": "દાન", "menu:volunteer": "સ્વયંસેવક", "menu:suggestion": "સૂચન" },
};

const MENU_ORDER: MenuId[] = ["menu:ambulance", "menu:clinic", "menu:donate", "menu:volunteer", "menu:suggestion"];

/** Rows for the Interakt InteractiveList (titles ≤ 24 chars per WhatsApp). */
export function menuRows(lang: Language = "en"): { id: MenuId; title: string }[] {
  const titles = ROW_TITLES[lang] ?? ROW_TITLES.en;
  return MENU_ORDER.map((id) => ({ id, title: titles[id] }));
}

/** "menu:ambulance" → "ambulance" for the transcript; null for unknown ids. */
export function menuChoiceLabel(id: string): string | null {
  return (MENU_ORDER as string[]).includes(id) ? id.slice("menu:".length) : null;
}
