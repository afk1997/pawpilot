import { describe, it, expect } from "vitest";
import { detectLanguage, isGreetingOnly, isMenuWord, languageForScript } from "@/server/lang";

describe("detectLanguage", () => {
  it("detects scripts, and reads Latin-script Hinglish as English, as Claude reports it", () => {
    expect(detectLanguage("hello there")).toBe("en");
    expect(detectLanguage("कुत्ता घायल है")).toBe("hi");
    expect(detectLanguage("कुत्रा जखमी आहे")).toBe("mr");
    expect(detectLanguage("કૂતરો ઘાયલ છે")).toBe("gu");
    expect(detectLanguage("bhai kutta ghayal hai")).toBe("en");
    expect(detectLanguage("ghatkopar me kutta ghayal hai, jaldi madad karo")).toBe("en");
    expect(detectLanguage("ambulance please")).toBe("en");
    expect(detectLanguage("")).toBe("en");
  });
  it("reads a Marathi marker stem with a vowel sign or anusvara after it as Marathi", () => {
    for (const t of ["रस्त्यावर बघितला", "मी पाहिलं", "आता काय करायचे?", "करायचं", "पाहिली होती"]) expect(detectLanguage(t), t).toBe("mr");
    for (const t of ["मैंने देखा", "सड़क पर घायल कुत्ता"]) expect(detectLanguage(t), t).toBe("hi");
  });
});

describe("languageForScript", () => {
  const amb = "{{AMB:amb_kcmfpbca}}";
  it("reads a reply labelled hi with no Devanagari character as English", () => {
    const hinglish = `Namaste! Rajkot mein gaay ghayal hai, sun ke dukh hua. Aap in dono mein se kisi ko call kar sakte hain: ${amb}`;
    expect(languageForScript("hi", hinglish)).toBe("en");
    expect(languageForScript("hi", `Call ${amb} now.`)).toBe("en");
  });
  it("reads a reply labelled mr with no Devanagari character as English", () => {
    expect(languageForScript("mr", `Punyat don ambulance aahet: ${amb}. Lagech call kara.`)).toBe("en");
  });
  it("reads a reply labelled gu with no Gujarati character as English, a Devanagari one included", () => {
    expect(languageForScript("gu", `Surat ma ek ambulance che: ${amb}. Turant call karo.`)).toBe("en");
    expect(languageForScript("gu", `कृपया ${amb} पर कॉल करें।`)).toBe("en");
  });
  it("never changes a label the other way: a script it carries keeps it, en stays en, and hi against mr is Claude's call", () => {
    expect(languageForScript("hi", `कृपया ${amb} पर कॉल करें।`)).toBe("hi");
    expect(languageForScript("mr", `कृपया ${amb} वर लगेच कॉल करा.`)).toBe("mr");
    expect(languageForScript("gu", `કૃપા કરીને ${amb} પર તરત જ કૉલ કરો.`)).toBe("gu");
    // One character of the label's script anywhere is enough: a Hinglish reply holding a Devanagari word keeps hi.
    expect(languageForScript("hi", `Rajkot mein do units hain, कृपया ${amb} par call karein`)).toBe("hi");
    expect(languageForScript("en", `कृपया ${amb} पर कॉल करें।`)).toBe("en");
    expect(languageForScript("en", "કૃપા કરીને કૉલ કરો.")).toBe("en");
    expect(languageForScript("hi", "पुण्यात दोन एम्बुलन्स आहेत.")).toBe("hi");
    expect(languageForScript("mr", "पुणे में दो एम्बुलेंस हैं।")).toBe("mr");
  });
  it("reads the Devanagari block as U+0900 to U+097F and the Gujarati block as U+0A80 to U+0AFF", () => {
    for (const c of ["\u0900", "\u097F"]) for (const label of ["hi", "mr"] as const) expect(languageForScript(label, `ok ${c}`)).toBe(label);
    for (const c of ["\u08FF", "\u0980"]) for (const label of ["hi", "mr"] as const) expect(languageForScript(label, `ok ${c}`)).toBe("en");
    for (const c of ["\u0A80", "\u0AFF"]) expect(languageForScript("gu", `ok ${c}`)).toBe("gu");
    for (const c of ["\u0A7F", "\u0B00"]) expect(languageForScript("gu", `ok ${c}`)).toBe("en");
  });
});

describe("isGreetingOnly", () => {
  it("accepts greetings, emoji, empty and menu words", () => {
    for (const t of ["hi", "Hello!", "namaste", "नमस्ते", "નમસ્તે", "🙏", "", "hey there", "menu"]) expect(isGreetingOnly(t)).toBe(true);
  });
  it("rejects anything with substance", () => {
    for (const t of ["hi, dog injured in ghatkopar", "ambulance", "donate", "घाटकोपर में कुत्ता"]) expect(isGreetingOnly(t)).toBe(false);
  });
  it("treats digits as content, never as greeting noise", () => {
    expect(isGreetingOnly("400077")).toBe(false);
    expect(isGreetingOnly("hi 400077")).toBe(false);
    for (const t of ["🙏", "🙏🏽", "❤️"]) expect(isGreetingOnly(t)).toBe(true);
  });
  it("accepts multi-word greetings only as the whole message", () => {
    expect(isGreetingOnly("good morning")).toBe(true);
    expect(isGreetingOnly("thank you")).toBe(true);
    expect(isGreetingOnly("Thanks a lot! 🙏")).toBe(true);
    expect(isGreetingOnly("good morning, dog injured in ghatkopar")).toBe(false);
  });
});

describe("isMenuWord", () => {
  it("matches the menu keywords in all languages", () => {
    for (const t of ["menu", "MENU", "options", "help", "मेन्यू", "मेनू", "પર્યાય", "મેનુ", "menyu"]) expect(isMenuWord(t)).toBe(true);
    expect(isMenuWord("help me my dog is hurt")).toBe(false);
  });
  it("ignores punctuation and emoji around a menu word", () => {
    for (const t of ["menu?", "Menu!!", " options. ", "मेनू।", "menu 🙏"]) expect(isMenuWord(t), t).toBe(true);
    expect(isMenuWord("menu please")).toBe(false);
  });
});
