import { describe, it, expect } from "vitest";
import type { Conversation, Message } from "@/server/db/schema";
import { OTHER_INTENT_WORDS, fastPathDecision, hasOtherIntentWord } from "@/server/worker/fast-path";

/** The decision for a one-text burst; an other-intent word decides it before any database read. */
const decide = (content: string) =>
  fastPathDecision({ id: "conversation-without-db" } as Conversation, [{ kind: "text", content, placeLabel: null } as Message], () => {
    throw new Error("the directory must not be read");
  });

describe("fast path other-intent words", () => {
  it("is the one list the rulings fixed, every word found on its own", () => {
    expect([...OTHER_INTENT_WORDS]).toEqual([
      "clinic", "clinik", "hospital", "doctor", "dawakhana", "क्लिनिक", "दवाखाना", "अस्पताल", "डॉक्टर", "દવાખાન", "હોસ્પિટલ",
      "donate", "donation", "daan", "दान", "દાન", "volunteer", "स्वयंसेवक", "સ્વયંસેવક",
      "human", "insaan", "इंसान", "person", "talk", "baat", "complaint", "shikayat", "शिकायत", "ફરિયાદ",
      "wrong", "galat", "गलत", "ખોટ",
      "utha", "uthaya", "uthata", "uthate", "uthaate", "switched", "unreachable", "reachable", "answering",
      "उठा", "उठाया", "उठाता", "बंद", "ઉપાડ", "બંધ",
      "aadmi", "admi", "vyakti", "आदमी", "व्यक्ति", "माणूस", "વ્યક્તિ", "માણસ",
      "वालंटियर", "वॉलंटियर", "ક્લિનિક", "तक्रार", "देणगी",
    ]);
    for (const word of OTHER_INTENT_WORDS) expect(hasOtherIntentWord(word), word).toBe(true);
  });

  it.each([
    "Ghatkopar ambulance phone nahi utha raha",
    "Ghatkopar ka driver phone nahi utha raha, helpline?",
    "Ghatkopar me ek aadmi ka accident hua hai",
    "घाटकोपर ड्राइवर फोन नहीं उठा रहा",
    "इंदौर में वालंटियर बनना है",
    "नागपुरात तक्रार करायची आहे",
    "ભાવનગરમાં ક્લિનિક ક્યાં છે?",
  ])("keeps the fast path from firing, before any lookup: %s", async (text) => {
    expect(await decide(text)).toEqual({ fire: false, reason: "other_intent" });
  });

  it("finds a driver who does not answer, in Latin script", () => {
    for (const text of [
      "driver ne phone nahi uthaya", "koi phone nahi uthata", "woh log phone nahi uthate", "phone nahi uthaate", "phone is switched off",
      "the number is unreachable", "not reachable", "the driver is not answering",
    ]) expect(hasOtherIntentWord(text), text).toBe(true);
  });

  it("finds a hurt person, in Latin script", () => {
    for (const text of ["ek aadmi ghayal hai", "admi ko chot lagi", "ek vyakti ghayal hai"]) expect(hasOtherIntentWord(text), text).toBe(true);
  });

  it("finds English words in any case, plurals and endings included", () => {
    for (const text of [
      "is there a Clinic near Ghatkopar?", "nearest HOSPITALS in surat", "need a doctor", "I want to donate", "donations",
      "can I volunteer", "talk to a human please", "a real person", "I have a complaint", "wrong number",
    ]) expect(hasOtherIntentWord(text), text).toBe(true);
    expect(hasOtherIntentWord("dog injured near ghatkopar station")).toBe(false);
    expect(hasOtherIntentWord("Bangalore, a cat is hurt")).toBe(false);
  });

  it("finds Hinglish words", () => {
    for (const text of ["ghatkopar clinik kahan hai", "dawakhana ka number", "daan karna hai", "kisi insaan se baat karao", "shikayat hai", "galat number diya"]) {
      expect(hasOtherIntentWord(text), text).toBe(true);
    }
    expect(hasOtherIntentWord("ghatkopar me kutta ghayal hai")).toBe(false);
    expect(hasOtherIntentWord("ghatkopar station ke paas kutta ghayal hai, khoon nikal raha hai please jaldi")).toBe(false);
  });

  it("finds Hindi words, a nukta spelling included, but not inside another word", () => {
    for (const text of ["घाटकोपर में क्लिनिक है?", "अस्पताल कहाँ है", "डॉक्टर चाहिए", "दान करना है", "किसी इंसान से बात", "शिकायत करनी है", "गलत नंबर", "ग़लत नंबर"]) {
      expect(hasOtherIntentWord(text), text).toBe(true);
    }
    expect(hasOtherIntentWord("घाटकोपर में कुत्ता घायल है")).toBe(false);
    expect(hasOtherIntentWord("यह वरदान है")).toBe(false);
  });

  it("finds Hindi words for a driver who does not answer, a hurt person and the menu's volunteering", () => {
    for (const text of [
      "ड्राइवर फोन नहीं उठा रहा", "किसी ने फोन नहीं उठाया", "कोई फोन नहीं उठाता", "फोन बंद है", "एक आदमी घायल है", "एक व्यक्ति घायल है",
      "मुझे वालंटियर बनना है", "वॉलंटियर कैसे बनें",
    ]) expect(hasOtherIntentWord(text), text).toBe(true);
  });

  it("finds Marathi words, Marathi-only ones included", () => {
    for (const text of [
      "घाटकोपरमध्ये दवाखाना आहे का?", "मला दान करायचे आहे", "मला स्वयंसेवक व्हायचे आहे", "डॉक्टर हवा आहे",
      "मला तक्रार करायची आहे", "मला देणगी द्यायची आहे", "एक माणूस जखमी आहे", "फोन बंद आहे",
    ]) {
      expect(hasOtherIntentWord(text), text).toBe(true);
    }
    expect(hasOtherIntentWord("पुण्यात कुत्रा जखमी आहे")).toBe(false);
  });

  it("finds Gujarati words with their endings", () => {
    for (const text of [
      "દવાખાનું ક્યાં છે?", "હોસ્પિટલમાં લઈ જવું છે", "દાન કરવું છે", "સ્વયંસેવક બનવું છે", "ફરિયાદ છે", "ખોટો નંબર છે",
      "ડ્રાઈવર ફોન ઉપાડતા નથી", "ફોન બંધ છે", "એક માણસ ઘાયલ છે", "એક વ્યક્તિ ઘાયલ છે", "ક્લિનિક ક્યાં છે?",
    ]) {
      expect(hasOtherIntentWord(text), text).toBe(true);
    }
    expect(hasOtherIntentWord("સુરતમાં ગાય ઘાયલ છે")).toBe(false);
  });

  it("leaves the words it was not given alone: band (Bandra), man, accident", () => {
    for (const text of ["bandra me kutta ghayal hai", "Bandra station, dog hit", "a man hit the dog in Chembur", "the dog met with an accident in Malad"]) {
      expect(hasOtherIntentWord(text), text).toBe(false);
    }
  });

  it("blocks no place the directory fixture covers, in any script its aliases know", () => {
    const places = [
      "Mumbai", "Ghatkopar", "Vikhroli", "Kurla", "Malad", "Kandivali", "Andheri", "Jogeshwari", "Vile Parle", "Bandra", "Khar", "Santacruz",
      "Chembur", "Govandi", "Mulund", "Bhandup", "Nahur", "Rajkot", "Surat", "Vesu", "Varachha", "Bengaluru", "Bangalore", "Pune", "PMC",
      "Kothrud", "Karve Nagar", "Shivajinagar", "PCMC", "Pimpri", "Chinchwad", "Hinjewadi",
      "घाटकोपर", "अंधेरी", "बांद्रा", "मलाड", "कांदिवली", "बोरीवली", "गोरेगांव", "चेंबूर", "मुलुंड", "दादर", "वडाला", "ठाणे", "कल्याण",
      "डोंबिवली", "कोथरूड", "पिंपरी", "चिंचवड", "हिंजवडी", "शिवाजीनगर", "मुंबई", "पुणे", "सूरत", "राजकोट", "વેસુ", "વરાછા", "ઘાટકોપર",
      "અંધેરી", "મુંબઈ", "સુરત", "રાજકોટ", "ભાવનગર",
    ];
    for (const place of places) expect(hasOtherIntentWord(`${place} me kutta ghayal hai`), place).toBe(false);
  });
});
