import { getConfig } from "../config";
import type { Language } from "../types";

export type MenuId = "menu:ambulance" | "menu:clinic" | "menu:donate" | "menu:volunteer" | "menu:suggestion";

const WELCOME_BY_LANG: Record<Language, (site: string) => string> = {
  en: (site) => `Namaste! 🙏 Thank you for texting Arham Always Care helpline.

How may I assist you today?

🚑  *Animal ambulance* — for an injured or sick stray animal
💝  *Donate* — support free animal rescue
🤝  *Volunteer* — join our team
🏥  *Hospitals & clinics* — find one near you
✉️  *Suggestion* — share feedback

Just reply with what you need (e.g. "ambulance", "donate"), or visit ${site}`,
  hi: (site) => `नमस्ते! 🙏 Arham Always Care हेल्पलाइन को संदेश भेजने के लिए धन्यवाद।

मैं आपकी कैसे मदद कर सकता हूँ?

🚑  *एनिमल एम्बुलेंस* — घायल या बीमार जानवर के लिए
💝  *दान* — मुफ़्त पशु बचाव में सहयोग
🤝  *वालंटियर* — हमारी टीम से जुड़ें
🏥  *हॉस्पिटल और क्लिनिक* — अपने पास का खोजें
✉️  *सुझाव* — फ़ीडबैक भेजें

बस जो चाहिए वो लिख दीजिए, या ${site} देखें।`,
  mr: (site) => `नमस्कार! 🙏 Arham Always Care हेल्पलाइनला संदेश पाठवल्याबद्दल धन्यवाद.

मी तुम्हाला कशी मदत करू शकतो?

🚑  *एनिमल एम्बुलन्स* — जखमी किंवा आजारी प्राण्यासाठी
💝  *दान* — मोफत प्राणी बचावासाठी मदत
🤝  *स्वयंसेवक* — आमच्या टीमसोबत सामील व्हा
🏥  *हॉस्पिटल आणि क्लिनिक* — जवळचे शोधा
✉️  *सूचना* — अभिप्राय शेअर करा

तुम्हाला काय हवे ते लिहा, किंवा ${site} पहा.`,
  gu: (site) => `નમસ્તે! 🙏 Arham Always Care હેલ્પલાઇનને સંદેશ મોકલવા બદલ આભાર.

હું તમને કેવી રીતે મદદ કરી શકું?

🚑  *એનિમલ એમ્બ્યુલન્સ* — ઘાયલ અથવા બીમાર પ્રાણી માટે
💝  *દાન* — મફત પ્રાણી બચાવમાં સહયોગ
🤝  *સ્વયંસેવક* — અમારી ટીમમાં જોડાઓ
🏥  *હોસ્પિટલ અને ક્લિનિક* — નજીકનું શોધો
✉️  *સૂચન* — પ્રતિસાદ આપો

જે જોઈતું હોય તે લખો, અથવા ${site} જુઓ.`,
};

const MENU_BY_LANG: Record<Language, (site: string) => string> = {
  en: (site) => `How can we help?\n\n🚑  *Animal ambulance*\n💝  *Donate*\n🤝  *Volunteer*\n🏥  *Hospitals & clinics*\n✉️  *Suggestion*\n\nReply with the option, or visit ${site}`,
  hi: (site) => `हम आपकी कैसे मदद करें?\n\n🚑  *एनिमल एम्बुलेंस*\n💝  *दान*\n🤝  *वालंटियर*\n🏥  *हॉस्पिटल और क्लिनिक*\n✉️  *सुझाव*\n\nविकल्प लिखें, या ${site} देखें।`,
  mr: (site) => `आम्ही कशी मदत करू?\n\n🚑  *एनिमल एम्बुलन्स*\n💝  *दान*\n🤝  *स्वयंसेवक*\n🏥  *हॉस्पिटल आणि क्लिनिक*\n✉️  *सूचना*\n\nपर्याय लिहा, किंवा ${site} पहा.`,
  gu: (site) => `અમે કેવી રીતે મદદ કરી શકીએ?\n\n🚑  *એનિમલ એમ્બ્યુલન્સ*\n💝  *દાન*\n🤝  *સ્વયંસેવક*\n🏥  *હોસ્પિટલ અને ક્લિનિક*\n✉️  *સૂચન*\n\nવિકલ્પ લખો, અથવા ${site} જુઓ.`,
};

let site: string | null = null;
/** Called once at startup with config.websiteUrl; until then the texts read the URL from the config. */
export function setWebsiteUrl(url: string): void {
  site = url;
}

function websiteUrl(): string {
  return site ?? getConfig().websiteUrl;
}

export function welcomeText(lang: Language = "en"): string {
  return (WELCOME_BY_LANG[lang] ?? WELCOME_BY_LANG.en)(websiteUrl());
}

export function menuText(lang: Language = "en"): string {
  return (MENU_BY_LANG[lang] ?? MENU_BY_LANG.en)(websiteUrl());
}

/** WhatsApp list button label, max 20 chars. */
export const MENU_BUTTON_LABEL: Record<Language, string> = { en: "Options", hi: "विकल्प", mr: "पर्याय", gu: "વિકલ્પો" };

/** WhatsApp list section title, max 24 chars. */
export const MENU_SECTION_TITLE: Record<Language, string> = { en: "Choose an option", hi: "एक विकल्प चुनें", mr: "एक पर्याय निवडा", gu: "એક વિકલ્પ પસંદ કરો" };

const ROW_TITLES: Record<Language, Record<MenuId, string>> = {
  en: { "menu:ambulance": "Animal ambulance", "menu:clinic": "Hospitals & clinics", "menu:donate": "Donate", "menu:volunteer": "Volunteer", "menu:suggestion": "Suggestion" },
  hi: { "menu:ambulance": "एनिमल एम्बुलेंस", "menu:clinic": "हॉस्पिटल और क्लिनिक", "menu:donate": "दान", "menu:volunteer": "वालंटियर", "menu:suggestion": "सुझाव" },
  mr: { "menu:ambulance": "एनिमल एम्बुलन्स", "menu:clinic": "हॉस्पिटल आणि क्लिनिक", "menu:donate": "दान", "menu:volunteer": "स्वयंसेवक", "menu:suggestion": "सूचना" },
  gu: { "menu:ambulance": "એનિમલ એમ્બ્યુલન્સ", "menu:clinic": "હોસ્પિટલ અને ક્લિનિક", "menu:donate": "દાન", "menu:volunteer": "સ્વયંસેવક", "menu:suggestion": "સૂચન" },
};

const MENU_ORDER: MenuId[] = ["menu:ambulance", "menu:clinic", "menu:donate", "menu:volunteer", "menu:suggestion"];

/**
 * Rows for the Interakt InteractiveList (titles ≤ 24 chars per WhatsApp). The clinic row reads "Hospitals & clinics" (the
 * site's hospitals and its clinic); its id stays menu:clinic, as the intent and the find_clinics tool keep their names.
 */
export function menuRows(lang: Language = "en"): { id: MenuId; title: string }[] {
  const titles = ROW_TITLES[lang] ?? ROW_TITLES.en;
  return MENU_ORDER.map((id) => ({ id, title: titles[id] }));
}

/** "menu:ambulance" → "ambulance" for the transcript; null for unknown ids. */
export function menuChoiceLabel(id: string): string | null {
  return (MENU_ORDER as string[]).includes(id) ? id.slice("menu:".length) : null;
}
