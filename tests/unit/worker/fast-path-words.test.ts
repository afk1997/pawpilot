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
      "not picking", "picking up", "switch off", "switched off", "not responding", "no answer", "no response", "unable to reach",
      "nahi lag", "nahi lagta", "lag nahi", "phone band", "number band", "phone busy", "number busy", "busy aa", "busy hai",
      "didn't pick", "did not pick", "didn't answer", "did not answer", "didnt pick", "didnt answer", "switchoff", "switch-off",
      "उचल", "नहीं लग", "लग नहीं", "नही लग", "लागत नाही", "स्विच", "લાગતો નથી", "લાગતું નથી", "ઉપાડત",
      "aadmi", "admi", "vyakti", "आदमी", "व्यक्ति", "माणूस", "વ્યક્તિ", "માણસ",
      "ladka", "ladke", "ladki", "aurat", "woman", "boy", "girl", "man is", "man has", "man got", "man was",
      "लड़का", "लड़के", "लड़की", "औरत", "मुलगा", "मुलगी", "बाळ", "બાળક", "છોકરો", "છોકરી",
      "bachche ka accident", "bachche ko gaadi", "bachche ko takkar", "bachche ko maara",
      "बच्चे का एक्सीडेंट", "बच्चे को गाड़ी", "बच्चे को टक्कर", "बच्चे को मारा",
      "वालंटियर", "वॉलंटियर", "ક્લિનિક", "तक्रार", "देणगी",
      "हॉस्पिटल", "डाक्टर", "ડૉક્ટર", "ડોક્ટર", "suggestion", "sujhav", "सुझाव", "सूचना", "સૂચન",
    ]);
    for (const word of OTHER_INTENT_WORDS) expect(hasOtherIntentWord(word), word).toBe(true);
  });

  describe("the phrasings the first lists missed (re-review I-2)", () => {
    it.each([
      // A driver who does not answer.
      ["en", "Ghatkopar ambulance driver not picking up the call"],
      ["en", "Ghatkopar driver is not responding"],
      ["en", "Ghatkopar ambulance: no answer, please help"],
      ["en", "unable to reach Ghatkopar ambulance"],
      ["Hinglish", "Ghatkopar ambulance ka phone switch off hai"],
      ["Hinglish", "Ghatkopar wala phone nahi lag raha"],
      ["Hinglish", "Ghatkopar ka number busy aa raha hai"],
      ["Hinglish", "Ghatkopar ambulance ka phone band hai"],
      ["hi", "घाटकोपर एम्बुलेंस का फोन नहीं लग रहा"],
      ["hi", "घाटकोपर एम्बुलेंस का फोन स्विच ऑफ है"],
      ["mr", "घाटकोपर एम्बुलन्सचा फोन उचलत नाही"],
      ["mr", "घाटकोपर एम्बुलन्सचा फोन लागत नाही"],
      ["gu", "ઘાટકોપર એમ્બ્યુલન્સનો ફોન લાગતો નથી"],
      ["gu", "ઘાટકોપર એમ્બ્યુલન્સનું ફોન લાગતું નથી"],
      // A hurt person.
      ["en", "a man is injured near Ghatkopar station"],
      ["en", "a woman fell near Ghatkopar station"],
      ["Hinglish", "Ghatkopar me ek ladke ka accident hua hai"],
      ["Hinglish", "Ghatkopar me ek bachche ko gaadi ne maara"],
      ["hi", "घाटकोपर में एक बच्चे का एक्सीडेंट हुआ है"],
      ["hi", "घाटकोपर में एक लड़का घायल है"],
      ["mr", "घाटकोपरमध्ये एक मुलगा जखमी आहे"],
      ["gu", "ઘાટકોપરમાં એક બાળક ઘાયલ છે"],
      // Other requests: a hospital or doctor, and the menu's suggestion item.
      ["hi", "घाटकोपर में हॉस्पिटल कहाँ है"],
      ["hi", "मेरा एक सुझाव है"],
      ["mr", "माझी एक सूचना आहे"],
      ["gu", "ઘાટકોપરમાં ડૉક્ટર જોઈએ"],
      ["gu", "મારું એક સૂચન છે"],
      ["en", "Ghatkopar ke baare me yeh mera suggestion hai"],
    ])("goes to the model (%s): %s", async (_lang, text) => {
      expect(await decide(text)).toEqual({ fire: false, reason: "other_intent" });
    });

    it.each([
      ["didn't pick", "Ghatkopar ambulance driver didn't pick up"],
      ["did not pick", "the Ghatkopar driver did not pick the call"],
      ["didn't answer", "Ghatkopar ambulance didn't answer"],
      ["did not answer", "Ghatkopar ambulance did not answer my call"],
      ["नही लग", "घाटकोपर एम्बुलेंस का फोन नही लग रहा"],
      ["switchoff", "Ghatkopar ambulance ka phone switchoff hai"],
      ["switch-off", "Ghatkopar ambulance ka phone switch-off hai"],
      ["didn't pick, a phone's curly apostrophe", "Ghatkopar ambulance driver didn\u2019t pick up"],
      ["didnt pick, no apostrophe", "Ghatkopar driver didnt pick up the phone"],
      ["didnt answer, no apostrophe", "Ghatkopar ambulance didnt answer"],
    ])("goes to the model for %s: %s", async (_entry, text) => {
      expect(await decide(text)).toEqual({ fire: false, reason: "other_intent" });
    });

    it("reads an entry with or without its nukta, and a phrase across any whitespace", () => {
      for (const text of ["एक लड़का घायल है", "एक लड़का घायल है", "एक लडका घायल है", "phone\nband hai", "driver  not   picking"]) {
        expect(hasOtherIntentWord(text), text).toBe(true);
      }
    });

    it("leaves an animal's young, a busy road and the words it was not given to the fast path", () => {
      for (const text of [
        "Ghatkopar me kutte ka bachcha ghayal hai", "Ghatkopar me billi ka baccha ghayal hai", "घाटकोपर में कुत्ते का बच्चा घायल है",
        "busy road ke paas kutta ghayal hai, Ghatkopar", "Ghatkopar station ke bahar", "manhole me kutta gira hai",
      ]) expect(hasOtherIntentWord(text), text).toBe(false);
    });
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
