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
