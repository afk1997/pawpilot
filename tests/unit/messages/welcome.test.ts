import { describe, it, expect } from "vitest";
import { welcomeText, menuText, menuRows, MENU_BUTTON_LABEL, menuChoiceLabel } from "@/server/messages/welcome";

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
});
