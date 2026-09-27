import { describe, it, expect, vi } from "vitest";
import { resetConfigForTests } from "@/server/config";
import { LANGUAGES } from "@/server/types";
import {
  formatIndianPhone, partnerSuffix, buildAmbulanceCard, buildMultiAmbulanceCard, buildHelplineCard,
  buildClinicCard, renderNumberForToken, type CardAmbulance,
} from "@/server/messages/cards";

const arham: CardAmbulance = { city: "Mumbai", area: "Ghatkopar", phone: "+917000000001", operatorName: "Arham Yuva Seva Group", operatorIsArham: true };
const partner: CardAmbulance = { city: "Mumbai", area: "Wadala", phone: "+917000000007", operatorName: "Hope for Indies Trust", operatorIsArham: false };

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

  it("builds a multi card listing each unit", () => {
    const text = buildMultiAmbulanceCard([partner, arham], "en");
    expect(text.startsWith("2 ambulances are available in Mumbai. Please call any one of them:")).toBe(true);
    expect(text).toContain("1. Animal Ambulance, Wadala\n   +91 70000 00007\n   (operated by Hope for Indies Trust)");
    expect(text).toContain("2. Arham Animal Ambulance, Ghatkopar\n   +91 70000 00001");
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

  it("builds a clinic card and an empty-state line", () => {
    const t = buildClinicCard([{ label: "Arham Clinic Surat", city: "Surat", area: "Vesu", phone: "+912612345678", address: "Vesu Main Road", hours: "9am-7pm" }], "en");
    expect(t).toContain("*Arham Clinic Surat* (Surat — Vesu)");
    expect(t).toContain("📞 +91 26123 45678");
    expect(buildClinicCard([], "mr")).toContain("https://alwayscare.org/clinics");
  });

  it("links the empty-state line to the configured website's clinic list, in every language", () => {
    try {
      vi.stubEnv("WEBSITE_URL", "https://helpline.example.org/");
      resetConfigForTests();
      for (const lang of LANGUAGES) expect(buildClinicCard([], lang), lang).toContain("https://helpline.example.org/clinics");
    } finally {
      vi.unstubAllEnvs();
      resetConfigForTests();
    }
  });
});
