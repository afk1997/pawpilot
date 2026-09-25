import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { getStaticInfo, getStaticPhones, type InfoTopic } from "@/server/content/static";
import { LANGUAGES } from "@/server/types";

describe("getStaticInfo", () => {
  it("returns English donate content without TODO fields", () => {
    const c = getStaticInfo("donate", "en");
    expect(c.summary).toMatch(/donation/i);
    expect(c.url).toBe("https://alwayscare.org/donate");
    expect(JSON.stringify(c)).not.toMatch(/TODO/);
    expect(c.upi).toBeUndefined();
  });
  it("falls back to English for unfilled languages", () => {
    const c = getStaticInfo("donate", "gu");
    expect(c.summary).toMatch(/donation/i);
  });
  it("returns FAQ as question/answer pairs", () => {
    const faq = getStaticInfo("faq", "hi").faq as { question: string; answer: string }[];
    expect(faq.length).toBeGreaterThanOrEqual(3);
    expect(faq[0].question).toMatch(/free/i);
  });
  it("tokenizes phones in volunteer content and never exposes digits", () => {
    const c = getStaticInfo("volunteer", "en");
    expect(JSON.stringify(c)).not.toMatch(/\d{7,}/);
    const phones = getStaticPhones();
    expect(typeof phones).toBe("object");
  });
  it("returns the helpline token for the helpline topic", () => {
    const c = getStaticInfo("helpline", "mr");
    expect(c.phone).toBe("{{PHONE:helpline}}");
  });
  it("returns human emergency text with 112/108", () => {
    expect(getStaticInfo("human_emergency", "en").text).toMatch(/112|108/);
  });
});

const TOPICS: InfoTopic[] = ["donate", "volunteer", "about", "faq", "human_emergency", "helpline"];

describe("phone tokens in the shipped content", () => {
  it("returns no phone-like digit run for any topic in any language", () => {
    for (const topic of TOPICS) {
      for (const lang of LANGUAGES) {
        const json = JSON.stringify(getStaticInfo(topic, lang));
        expect(json, `${topic}/${lang}`).not.toMatch(/\d{7,}/);
        expect(json, `${topic}/${lang}`).not.toMatch(/\d[\d\s-]{6,}\d/);
      }
    }
  });
  it("tokenizes the Animal Helpline India number embedded in the FAQ", () => {
    const faq = getStaticInfo("faq", "en").faq as { question: string; answer: string }[];
    const uncovered = faq.find((e) => /city you cover/i.test(e.question));
    expect(uncovered?.answer).toContain("Animal Helpline India at {{PHONE:faq_1}}.");
    expect(getStaticPhones().faq_1).toBe("18004195860");
  });
});

// The shipped content has no filled phone field and no translated number, so whole-field
// keys, cross-language key reuse and the load-time registry run over a filled copy.
describe("phone tokenization over filled content", () => {
  let fresh: typeof import("@/server/content/static");

  beforeAll(async () => {
    vi.resetModules();
    vi.doMock("@/content/static.json", () => ({
      default: {
        volunteer: {
          en: { summary: "Ride along with an ambulance: call +91 70000 00008.", contact_phone: "+91 70000 00009" },
          hi: { summary: "एम्बुलेंस के साथ चलने के लिए +91 70000 00008 पर कॉल करें।", contact_phone: "TODO" },
          mr: { summary: "TODO", contact_phone: "+91 70000 00010" },
        },
      },
    }));
    fresh = await import("@/server/content/static");
  });

  afterAll(() => {
    vi.doUnmock("@/content/static.json");
    vi.resetModules();
  });

  it("registers every number at load, before any lookup", () => {
    expect(fresh.getStaticPhones()).toEqual({
      volunteer_1: "+917000000008",
      volunteer_contact_phone: "+917000000009",
      volunteer_contact_phone_mr: "+917000000010",
    });
  });

  it("hands out only tokens and keeps one key per number across languages", () => {
    expect(fresh.getStaticInfo("volunteer", "en")).toEqual({
      summary: "Ride along with an ambulance: call {{PHONE:volunteer_1}}.",
      contact_phone: "{{PHONE:volunteer_contact_phone}}",
    });
    expect(fresh.getStaticInfo("volunteer", "hi")).toEqual({
      summary: "एम्बुलेंस के साथ चलने के लिए {{PHONE:volunteer_1}} पर कॉल करें।",
      contact_phone: "{{PHONE:volunteer_contact_phone}}",
    });
    expect(fresh.getStaticInfo("volunteer", "mr").contact_phone).toBe("{{PHONE:volunteer_contact_phone_mr}}");
    for (const lang of LANGUAGES) {
      expect(JSON.stringify(fresh.getStaticInfo("volunteer", lang))).not.toMatch(/\+?\d(?:[\s-]?\d){6,}/);
    }
  });
});
