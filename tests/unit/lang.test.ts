import { describe, it, expect } from "vitest";
import { detectLanguage, isGreetingOnly, isMenuWord } from "@/server/lang";

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
