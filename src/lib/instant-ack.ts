/**
 * Instant acknowledgment messages — sent within ~1s of the reporter's first
 * message in a session, BEFORE any LLM call. Reporter never wonders if the
 * message went through.
 *
 * Localized; falls back to English if the language isn't yet filled in.
 */
import type { Language } from "./types";

const ACK_BY_LANG: Record<Language, string> = {
  en: "Got your message. To help fast, please share your area or a WhatsApp location pin.",
  hi: "आपका संदेश मिला। जल्दी मदद के लिए, कृपया अपना इलाका या WhatsApp लोकेशन पिन भेजें।",
  mr: "तुमचा संदेश मिळाला. लवकर मदतीसाठी, कृपया तुमचा भाग किंवा WhatsApp लोकेशन पिन पाठवा.",
  gu: "તમારો સંદેશ મળ્યો. ઝડપી મદદ માટે, કૃપા કરીને તમારો વિસ્તાર અથવા WhatsApp લોકેશન પિન મોકલો.",
};

const ACK_VOICE_BY_LANG: Record<Language, string> = {
  en: "Got your voice note — apologies, I can't process audio yet. Please type a brief description and share your area or a WhatsApp location pin.",
  hi: "वॉइस नोट मिला — माफ़ी, मैं अभी ऑडियो नहीं समझ सकता। कृपया संक्षेप में टाइप करें और अपना इलाका या लोकेशन पिन भेजें।",
  mr: "व्हॉइस नोट मिळाला — क्षमस्व, मी ऑडिओ अद्याप समजू शकत नाही. कृपया थोडक्यात टाइप करा आणि तुमचा भाग किंवा लोकेशन पिन पाठवा.",
  gu: "વૉઇસ નોટ મળ્યો — માફ કરશો, હું હજી ઓડિયો સમજી શકતો નથી. કૃપા કરીને ટૂંકમાં ટાઇપ કરો અને તમારો વિસ્તાર અથવા લોકેશન પિન મોકલો.",
};

export function instantAck(language: Language | null, isVoiceNote: boolean): string {
  const lang = (language ?? "en") as Language;
  const table = isVoiceNote ? ACK_VOICE_BY_LANG : ACK_BY_LANG;
  return table[lang] ?? table.en;
}
