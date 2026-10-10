import { describe, it, expect, vi } from "vitest";
import { resetConfigForTests } from "@/server/config";
import { LANGUAGES } from "@/server/types";
import {
  formatIndianPhone, partnerSuffix, buildAmbulanceCard, buildAmbulanceCardTemplate, buildMultiAmbulanceCard, buildHelplineCard,
  buildClinicCard, hoursLine, renderNumberForToken, type CardAmbulance, type CardClinic,
} from "@/server/messages/cards";
import { findDigitRuns, foreignDigitRuns, maskDigitRuns } from "@/server/agent/scrub";

const arham: CardAmbulance = { city: "Mumbai", area: "Ghatkopar", phone: "+917000000001", operatorName: "Arham Yuva Seva Group", operatorIsArham: true };
const partner: CardAmbulance = { city: "Mumbai", area: "Wadala", phone: "+917000000007", operatorName: "Hope for Indies Trust", operatorIsArham: false };
/** The hours the site publishes, as the directory writes them. */
const PUBLISHED_HOURS = ["10am–7pm IST", "10am–11pm IST", "9am–6pm IST"];
const ludlow: CardClinic = {
  label: "Kolkata - Ludlow Hospital", city: "Kolkata", area: "Ludlow", phone: "+917000000020",
  address: "Near Chengail Railway Station, Howrah", hours: "9am–6pm IST",
};

describe("cards", () => {
  it("formats Indian phones", () => {
    expect(formatIndianPhone("+917000000001")).toBe("+91 70000 00001");
    expect(formatIndianPhone("7000000001")).toBe("+91 70000 00001");
    expect(formatIndianPhone("+441234567890")).toBe("+441234567890");
  });

  it("formats Indian toll-free numbers without a country code", () => {
    expect(formatIndianPhone("18004195860")).toBe("1800-419-5860");
    expect(formatIndianPhone("1800-419-5860")).toBe("1800-419-5860");
  });

  it("builds an Arham card without operator suffix", () => {
    expect(buildAmbulanceCard(arham, "en")).toBe("Arham Animal Ambulance, Ghatkopar\n+91 70000 00001\nPlease call them right away.");
  });

  it("builds a partner card with a localized operator suffix", () => {
    expect(buildAmbulanceCard(partner, "hi")).toBe("Animal Ambulance, Wadala\n+91 70000 00007\n(Hope for Indies Trust द्वारा संचालित)\nकृपया उन्हें तुरंत कॉल करें।");
    expect(partnerSuffix("Blue Cross", "gu")).toBe("(Blue Cross દ્વારા સંચાલિત)");
  });

  it("renders the token replacement with the partner label inline", () => {
    expect(renderNumberForToken(arham, "en")).toBe("+91 70000 00001");
    expect(renderNumberForToken(partner, "en")).toBe("+91 70000 00007 (operated by Hope for Indies Trust)");
  });

  it("builds a card's template: the token stands for what renderNumberForToken renders, the partner label included", () => {
    const token = "{{AMB:amb_abcdefgh}}";
    expect(buildAmbulanceCardTemplate(arham, "en", token)).toBe("Arham Animal Ambulance, Ghatkopar\n{{AMB:amb_abcdefgh}}\nPlease call them right away.");
    expect(buildAmbulanceCardTemplate(partner, "hi", token)).toBe("Animal Ambulance, Wadala\n{{AMB:amb_abcdefgh}}\nकृपया उन्हें तुरंत कॉल करें।");
    // Rendering the token back gives the card, the partner label on the number's line.
    for (const lang of LANGUAGES) {
      for (const row of [arham, partner]) {
        const rendered = buildAmbulanceCardTemplate(row, lang, token).replace(token, renderNumberForToken(row, lang));
        expect(rendered).toBe(buildAmbulanceCard(row, lang).replace(`${formatIndianPhone(row.phone)}\n(`, `${formatIndianPhone(row.phone)} (`));
        expect(buildAmbulanceCardTemplate(row, lang, token)).not.toMatch(/\d/);
      }
    }
  });

  it("adds a unit's hours on their own line, in the card's language, as the directory writes them", () => {
    const withHours = { ...arham, hours: "10am–7pm IST" };
    expect(buildAmbulanceCard(withHours, "en")).toBe(
      "Arham Animal Ambulance, Ghatkopar\n+91 70000 00001\nHours: 10am–7pm IST (call to confirm)\nPlease call them right away."
    );
    expect(buildAmbulanceCard(withHours, "hi")).toBe(
      "Arham Animal Ambulance, Ghatkopar\n+91 70000 00001\nसमय: 10am–7pm IST (कॉल करके पुष्टि करें)\nकृपया उन्हें तुरंत कॉल करें।"
    );
    expect(buildAmbulanceCard(withHours, "mr")).toContain("\nवेळ: 10am–7pm IST (कॉल करून खात्री करा)\n");
    expect(buildAmbulanceCard(withHours, "gu")).toContain("\nસમય: 10am–7pm IST (કૉલ કરીને ખાતરી કરો)\n");
    // A partner unit's label stays right under the number; the hours follow it.
    expect(buildAmbulanceCard({ ...partner, hours: "9am–6pm IST" }, "en")).toBe(
      "Animal Ambulance, Wadala\n+91 70000 00007\n(operated by Hope for Indies Trust)\nHours: 9am–6pm IST (call to confirm)\nPlease call them right away."
    );
    // No hours, or an empty cell: no line.
    for (const hours of [undefined, null, "", "  "]) expect(buildAmbulanceCard({ ...arham, hours }, "en")).toBe(buildAmbulanceCard(arham, "en"));
    expect(hoursLine(" 10am–11pm IST ", "en")).toBe("Hours: 10am–11pm IST (call to confirm)");
    expect(hoursLine(null, "mr")).toBeNull();
  });

  it("puts the hours line in the card's template too, the token alone standing for the number", () => {
    const token = "{{AMB:amb_abcdefgh}}";
    expect(buildAmbulanceCardTemplate({ ...arham, hours: "10am–7pm IST" }, "en", token)).toBe(
      "Arham Animal Ambulance, Ghatkopar\n{{AMB:amb_abcdefgh}}\nHours: 10am–7pm IST (call to confirm)\nPlease call them right away."
    );
    for (const lang of LANGUAGES) {
      for (const row of [{ ...arham, hours: "10am–7pm IST" }, { ...partner, hours: "9am–6pm IST" }]) {
        const template = buildAmbulanceCardTemplate(row, lang, token);
        const rendered = template.replace(token, renderNumberForToken(row, lang));
        expect(rendered).toBe(buildAmbulanceCard(row, lang).replace(`${formatIndianPhone(row.phone)}\n(`, `${formatIndianPhone(row.phone)} (`));
        // The hours' digits are the only ones left, as written.
        expect(template.replace(row.hours, "")).not.toMatch(/\d/);
      }
    }
  });

  it("leaves the published hours alone: the scrubber finds only the unit's number, and the template masking changes nothing", () => {
    const token = "{{AMB:amb_abcdefgh}}";
    for (const hours of PUBLISHED_HOURS) {
      for (const lang of LANGUAGES) {
        for (const row of [{ ...arham, hours }, { ...partner, hours }]) {
          const card = buildAmbulanceCard(row, lang);
          expect(findDigitRuns(card)).toEqual([formatIndianPhone(row.phone)]);
          expect(foreignDigitRuns(card, [row.phone])).toEqual([]);
          const template = buildAmbulanceCardTemplate(row, lang, token);
          expect(maskDigitRuns(template, "[number sent]")).toBe(template);
          const multi = buildMultiAmbulanceCard([row, { ...arham, phone: "+917000000002", hours }], lang);
          expect(foreignDigitRuns(multi, [row.phone, "+917000000002"])).toEqual([]);
        }
      }
      expect(findDigitRuns(buildClinicCard([{ ...ludlow, hours }], "en"))).toEqual(["+91 70000 00020"]);
    }
  });

  it("builds a multi card listing each unit", () => {
    const text = buildMultiAmbulanceCard([partner, arham], "en");
    expect(text.startsWith("2 ambulances are available in Mumbai. Please call any one of them:")).toBe(true);
    expect(text).toContain("1. Animal Ambulance, Wadala\n   +91 70000 00007\n   (operated by Hope for Indies Trust)");
    expect(text).toContain("2. Arham Animal Ambulance, Ghatkopar\n   +91 70000 00001");
  });

  it("lists each unit's hours in the multi card, under its number and a partner's label", () => {
    const text = buildMultiAmbulanceCard([{ ...partner, hours: "9am–6pm IST" }, { ...arham, hours: "10am–7pm IST" }], "mr");
    expect(text).toContain(
      "1. Animal Ambulance, Wadala\n   +91 70000 00007\n   (Hope for Indies Trust द्वारे चालवले जाते)\n   वेळ: 9am–6pm IST (कॉल करून खात्री करा)\n\n" +
        "2. Arham Animal Ambulance, Ghatkopar\n   +91 70000 00001\n   वेळ: 10am–7pm IST (कॉल करून खात्री करा)"
    );
    expect(buildMultiAmbulanceCard([partner, arham], "en")).not.toContain("Hours:");
  });

  it("drops the city from the multi card header when units are in different cities", () => {
    const rajkot: CardAmbulance = { city: "Rajkot", area: null, phone: "+919876500001", operatorName: "Blue Cross", operatorIsArham: false };
    expect(buildMultiAmbulanceCard([arham, rajkot], "en").split("\n")[0]).toBe("2 ambulances are available. Please call any one of them:");
    for (const lang of ["en", "hi", "mr", "gu"] as const) {
      const text = buildMultiAmbulanceCard([arham, rajkot], lang);
      expect(text.split("\n")[0]).not.toMatch(/Mumbai|Rajkot|Ghatkopar/);
      expect(text).toContain("+91 70000 00001");
      expect(text).toContain("+91 98765 00001");
    }
  });

  it("builds the helpline card in every language", () => {
    for (const lang of ["en", "hi", "mr", "gu"] as const) {
      const t = buildHelplineCard("+919999900000", lang);
      expect(t).toContain("+91 99999 00000");
      expect(t.split("\n").length).toBeGreaterThanOrEqual(2);
    }
  });

  it("builds a hospital and clinic card: each one's number, address and hours, and an empty-state line", () => {
    expect(buildClinicCard([ludlow], "en")).toBe(
      "Our hospitals and clinics\n\n*Kolkata - Ludlow Hospital* (Kolkata — Ludlow)\n📞 +91 70000 00020\n📍 Near Chengail Railway Station, Howrah\n" +
        "🕒 Hours: 9am–6pm IST (call to confirm)"
    );
    const t = buildClinicCard([{ label: "Arham Clinic Surat", city: "Surat", area: "Vesu", phone: "+912612345678", address: null, hours: null }], "hi");
    expect(t).toBe("हमारे हॉस्पिटल और क्लिनिक\n\n*Arham Clinic Surat* (Surat — Vesu)\n📞 +91 26123 45678");
    expect(buildClinicCard([ludlow], "mr")).toContain("आमची हॉस्पिटल आणि क्लिनिक\n");
    expect(buildClinicCard([ludlow], "gu")).toContain("અમારી હોસ્પિટલ અને ક્લિનિક\n");
    expect(buildClinicCard([ludlow], "gu")).toContain("🕒 સમય: 9am–6pm IST (કૉલ કરીને ખાતરી કરો)");
    expect(buildClinicCard([], "en")).toBe("We don't have a hospital or clinic in that city yet. Visit https://alwayscare.org/hospitals for the full list.");
    expect(buildClinicCard([], "mr")).toContain("https://alwayscare.org/hospitals");
  });

  it("lists at most six hospitals and clinics", () => {
    const seven = Array.from({ length: 7 }, (_, i): CardClinic => ({ ...ludlow, label: `Hospital ${i + 1}`, address: null, hours: null }));
    const card = buildClinicCard(seven, "en");
    expect(card).toContain("*Hospital 6*");
    expect(card).not.toContain("*Hospital 7*");
  });

  it("links the empty-state line to the configured website's hospital list, in every language", () => {
    try {
      vi.stubEnv("WEBSITE_URL", "https://helpline.example.org/");
      resetConfigForTests();
      for (const lang of LANGUAGES) expect(buildClinicCard([], lang), lang).toContain("https://helpline.example.org/hospitals");
    } finally {
      vi.unstubAllEnvs();
      resetConfigForTests();
    }
  });
});
