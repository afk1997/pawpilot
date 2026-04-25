/**
 * Localized follow-up messages — sent N minutes after the agent delivered an
 * ambulance driver's phone number. Asks the reporter whether they were able
 * to reach the driver. "No" / "couldn't reach" → escalation; "yes" →
 * conversation continues with case-context gathering.
 */
import type { Language } from "../types";

export function followupMessage(language: Language, driverName: string | null): string {
  const driver = driverName ?? "the driver";
  switch (language) {
    case "hi":
      return `क्या आप ${driver} से बात कर पाए? कृपया हाँ या नहीं में जवाब दें।`;
    case "mr":
      return `तुम्ही ${driver} शी बोलू शकलात का? कृपया होय किंवा नाही असे उत्तर द्या.`;
    case "gu":
      return `શું તમે ${driver} સાથે વાત કરી શક્યા? કૃપા કરીને હા અથવા ના માં જવાબ આપો.`;
    case "en":
    default:
      return `Were you able to reach ${driver}? Please reply YES or NO.`;
  }
}
