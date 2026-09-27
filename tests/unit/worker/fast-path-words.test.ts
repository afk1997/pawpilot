import { describe, it, expect } from "vitest";
import { OTHER_INTENT_WORDS, hasOtherIntentWord } from "@/server/worker/fast-path";

describe("fast path other-intent words", () => {
  it("is the one list the brief fixed, every word found on its own", () => {
    expect([...OTHER_INTENT_WORDS]).toEqual([
      "clinic", "clinik", "hospital", "doctor", "dawakhana", "क्लिनिक", "दवाखाना", "अस्पताल", "डॉक्टर", "દવાખાન", "હોસ્પિટલ",
      "donate", "donation", "daan", "दान", "દાન", "volunteer", "स्वयंसेवक", "સ્વયંસેવક",
      "human", "insaan", "इंसान", "person", "talk", "baat", "complaint", "shikayat", "शिकायत", "ફરિયાદ",
      "wrong", "galat", "गलत", "ખોટ",
    ]);
    for (const word of OTHER_INTENT_WORDS) expect(hasOtherIntentWord(word), word).toBe(true);
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

  it("finds Marathi words", () => {
    for (const text of ["घाटकोपरमध्ये दवाखाना आहे का?", "मला दान करायचे आहे", "मला स्वयंसेवक व्हायचे आहे", "डॉक्टर हवा आहे"]) {
      expect(hasOtherIntentWord(text), text).toBe(true);
    }
    expect(hasOtherIntentWord("पुण्यात कुत्रा जखमी आहे")).toBe(false);
  });

  it("finds Gujarati words with their endings", () => {
    for (const text of ["દવાખાનું ક્યાં છે?", "હોસ્પિટલમાં લઈ જવું છે", "દાન કરવું છે", "સ્વયંસેવક બનવું છે", "ફરિયાદ છે", "ખોટો નંબર છે"]) {
      expect(hasOtherIntentWord(text), text).toBe(true);
    }
    expect(hasOtherIntentWord("સુરતમાં ગાય ઘાયલ છે")).toBe(false);
  });
});
