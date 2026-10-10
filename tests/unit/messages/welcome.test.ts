import { describe, it, expect } from "vitest";
import { resetConfigForTests } from "@/server/config";
import { LANGUAGES } from "@/server/types";
import { welcomeText, menuText, menuRows, MENU_BUTTON_LABEL, MENU_SECTION_TITLE, menuChoiceLabel } from "@/server/messages/welcome";

describe("welcome and menu", () => {
  it("has five list rows with WhatsApp-safe titles in every language", () => {
    for (const lang of ["en", "hi", "mr", "gu"] as const) {
      const rows = menuRows(lang);
      expect(rows.map((r) => r.id)).toEqual(["menu:ambulance", "menu:clinic", "menu:donate", "menu:volunteer", "menu:suggestion"]);
      for (const r of rows) expect(r.title.length).toBeLessThanOrEqual(24);
      expect(MENU_BUTTON_LABEL[lang].length).toBeLessThanOrEqual(20);
      expect(welcomeText(lang)).toContain("Arham Always Care");
      expect(menuText(lang).length).toBeGreaterThan(10);
    }
  });
  it("names hospitals and clinics in the welcome, the menu and the list row, in every language", () => {
    const rows = {
      en: ["🏥  *Hospitals & clinics* — find one near you", "🏥  *Hospitals & clinics*\n", "Hospitals & clinics"],
      hi: ["🏥  *हॉस्पिटल और क्लिनिक* — अपने पास का खोजें", "🏥  *हॉस्पिटल और क्लिनिक*\n", "हॉस्पिटल और क्लिनिक"],
      mr: ["🏥  *हॉस्पिटल आणि क्लिनिक* — जवळचे शोधा", "🏥  *हॉस्पिटल आणि क्लिनिक*\n", "हॉस्पिटल आणि क्लिनिक"],
      gu: ["🏥  *હોસ્પિટલ અને ક્લિનિક* — નજીકનું શોધો", "🏥  *હોસ્પિટલ અને ક્લિનિક*\n", "હોસ્પિટલ અને ક્લિનિક"],
    } as const;
    for (const lang of LANGUAGES) {
      const [welcomeLine, menuLine, rowTitle] = rows[lang];
      expect(welcomeText(lang), lang).toContain(welcomeLine);
      expect(menuText(lang), lang).toContain(menuLine);
      // The row keeps its id: the intent and the find_clinics tool keep their names.
      expect(menuRows(lang).find((r) => r.id === "menu:clinic")?.title, lang).toBe(rowTitle);
      expect(rowTitle.length).toBeLessThanOrEqual(24);
      expect(`${welcomeText(lang)}${menuText(lang)}`, lang).not.toMatch(/Clinic info|क्लिनिक जानकारी|क्लिनिक माहिती|ક્લિનિક માહિતી/);
    }
    expect(menuChoiceLabel("menu:clinic")).toBe("clinic");
  });
  it("maps a list reply id to a transcript label", () => {
    expect(menuChoiceLabel("menu:ambulance")).toBe("ambulance");
    expect(menuChoiceLabel("nonsense")).toBeNull();
  });
  it("titles the list section in all four languages within WhatsApp's 24 characters", () => {
    expect(Object.keys(MENU_SECTION_TITLE).sort()).toEqual([...LANGUAGES].sort());
    for (const lang of LANGUAGES) {
      expect(MENU_SECTION_TITLE[lang].trim().length).toBeGreaterThan(0);
      expect(MENU_SECTION_TITLE[lang].length).toBeLessThanOrEqual(24);
    }
  });
  it("links the configured website when setWebsiteUrl was never called", () => {
    const configured = process.env.WEBSITE_URL;
    process.env.WEBSITE_URL = "https://helpline.example.org";
    resetConfigForTests();
    try {
      expect(welcomeText("en")).toContain("https://helpline.example.org");
      expect(menuText("gu")).toContain("https://helpline.example.org");
    } finally {
      if (configured === undefined) delete process.env.WEBSITE_URL;
      else process.env.WEBSITE_URL = configured;
      resetConfigForTests();
    }
  });
});
