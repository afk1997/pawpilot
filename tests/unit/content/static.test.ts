import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { getStaticInfo, getStaticPhones, foldDigits, type InfoTopic } from "@/server/content/static";
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
const WELL_FORMED_PHONE = /^(?:\+91\d{10}|\d{10}|1800\d{7})$/;

describe("phone tokens in the shipped content", () => {
  it("returns no phone-like digit run and no TODO for any topic in any language", () => {
    for (const topic of TOPICS) {
      for (const lang of LANGUAGES) {
        const json = foldDigits(JSON.stringify(getStaticInfo(topic, lang)));
        expect(json, `${topic}/${lang}`).not.toMatch(/\d{7,}/);
        expect(json, `${topic}/${lang}`).not.toMatch(/\d[\d\s-]{6,}\d/);
        expect(json, `${topic}/${lang}`).not.toMatch(/TODO/);
      }
    }
  });
  it("tokenizes the Animal Helpline India number embedded in the FAQ", () => {
    const faq = getStaticInfo("faq", "en").faq as { question: string; answer: string }[];
    const uncovered = faq.find((e) => /city you cover/i.test(e.question));
    expect(uncovered?.answer).toContain("Animal Helpline India at {{PHONE:faq_1}}.");
    expect(getStaticPhones().faq_1).toBe("18004195860");
  });
  it("registers only well-formed Indian numbers", () => {
    const phones = getStaticPhones();
    for (const [key, phone] of Object.entries(phones)) expect(phone, key).toMatch(WELL_FORMED_PHONE);
    expect(phones).toEqual({ faq_1: "18004195860" });
  });
});

/** A fresh loader over `json` in place of the shipped content file. */
async function loadStaticWith(json: unknown): Promise<typeof import("@/server/content/static")> {
  vi.resetModules();
  vi.doMock("@/content/static.json", () => ({ default: json }));
  return import("@/server/content/static");
}

function unmockStatic(): void {
  vi.doUnmock("@/content/static.json");
  vi.resetModules();
}

// The shipped content has no filled phone field and no translated number, so whole-field
// keys, cross-language key reuse and the load-time registry run over a filled copy.
describe("phone tokenization over filled content", () => {
  let fresh: typeof import("@/server/content/static");

  beforeAll(async () => {
    fresh = await loadStaticWith({
      volunteer: {
        en: { summary: "Ride along with an ambulance: call +91 70000 00008.", contact_phone: "+91 70000 00009" },
        hi: { summary: "एम्बुलेंस के साथ चलने के लिए +91 70000 00008 पर कॉल करें।", contact_phone: "TODO" },
        mr: { summary: "TODO", contact_phone: "+91 70000 00010" },
      },
    });
  });
  afterAll(unmockStatic);

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

describe("phone boundaries and native numerals", () => {
  let fresh: typeof import("@/server/content/static");

  beforeAll(async () => {
    fresh = await loadStaticWith({
      about: { en: "Animal Helpline India: 1800-419-5860 - 24x7. Steps:\n1. Call 1800-419-5860\n2. Ask a local rescue group." },
      donate: {
        hi: { summary: "दान के बारे में जानने के लिए १८००-४१९-५८६० पर कॉल करें। हमारे पास ४५+ एम्बुलेंस हैं।" },
        gu: { contact_phone: "૧૮૦૦-૪૧૯-૫૮૬૦" },
      },
    });
  });
  afterAll(unmockStatic);

  it("ends a number at a spaced hyphen or a line break", () => {
    expect(fresh.getStaticInfo("about", "en").text).toBe(
      "Animal Helpline India: {{PHONE:about_1}} - 24x7. Steps:\n1. Call {{PHONE:about_1}}\n2. Ask a local rescue group.",
    );
    expect(fresh.getStaticPhones().about_1).toBe("18004195860");
  });

  it("tokenizes Devanagari and Gujarati numerals, registers ASCII and keeps other numerals as written", () => {
    expect(fresh.getStaticInfo("donate", "hi").summary).toBe(
      "दान के बारे में जानने के लिए {{PHONE:donate_1}} पर कॉल करें। हमारे पास ४५+ एम्बुलेंस हैं।",
    );
    expect(fresh.getStaticInfo("donate", "gu").contact_phone).toBe("{{PHONE:donate_contact_phone}}");
    expect(fresh.getStaticPhones()).toEqual({ about_1: "18004195860", donate_1: "18004195860", donate_contact_phone: "18004195860" });
  });
});

describe("unfilled English content", () => {
  let fresh: typeof import("@/server/content/static");

  beforeAll(async () => {
    fresh = await loadStaticWith({
      about: { en: "TODO", hi: "TODO" },
      human_emergency: { en: "" },
      faq: [
        { q_en: "TODO", a_en: "TODO" },
        { q_en: "Is your service free?", a_en: "TODO" },
        { q_en: "Do you treat pets?", a_en: "Our priority is stray animals.", q_hi: "TODO" },
      ],
    });
  });
  afterAll(unmockStatic);

  it("omits unfilled text and FAQ entries instead of returning TODO or empty strings", () => {
    expect(fresh.getStaticInfo("about", "hi")).toEqual({});
    expect(fresh.getStaticInfo("human_emergency", "en")).toEqual({});
    expect(fresh.getStaticInfo("helpline", "en")).toEqual({ phone: "{{PHONE:helpline}}" });
    expect(fresh.getStaticInfo("faq", "hi")).toEqual({
      faq: [{ question: "Do you treat pets?", answer: "Our priority is stray animals." }],
    });
  });
});
