import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { getStaticInfo, getStaticPhones, foldDigits, type InfoTopic } from "@/server/content/static";
import { LANGUAGES } from "@/server/types";
import { HandleRegistry } from "@/server/agent/handles";
import type { ToolContext } from "@/server/agent/tools";

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
        hi: { summary: "TODO", contact_phone: "TODO" },
        mr: { summary: "TODO", contact_phone: "+91 70000 00010" },
      },
      about: {
        en: "Ride along with an ambulance: call +91 70000 00008.",
        hi: "एम्बुलेंस के साथ चलने के लिए +91 70000 00008 पर कॉल करें।",
      },
    });
  });
  afterAll(unmockStatic);

  it("registers every number at load, before any lookup", () => {
    expect(fresh.getStaticPhones()).toEqual({
      volunteer_contact_phone: "+917000000009",
      volunteer_contact_phone_mr: "+917000000010",
      about_1: "+917000000008",
    });
  });

  it("hands out only tokens for phone fields and free text, keeping one key per number across languages", () => {
    expect(fresh.getStaticInfo("volunteer", "en").contact_phone).toBe("{{PHONE:volunteer_contact_phone}}");
    expect(fresh.getStaticInfo("volunteer", "hi").contact_phone).toBe("{{PHONE:volunteer_contact_phone}}");
    expect(fresh.getStaticInfo("volunteer", "mr").contact_phone).toBe("{{PHONE:volunteer_contact_phone_mr}}");
    expect(fresh.getStaticInfo("about", "en").text).toBe("Ride along with an ambulance: call {{PHONE:about_1}}.");
    expect(fresh.getStaticInfo("about", "hi").text).toBe("एम्बुलेंस के साथ चलने के लिए {{PHONE:about_1}} पर कॉल करें।");
    for (const lang of LANGUAGES) {
      expect(JSON.stringify(fresh.getStaticInfo("about", lang))).not.toMatch(/\+?\d(?:[\s-]?\d){6,}/);
    }
  });

  it("passes a number in a field not named for a phone through as written, for the tool-boundary scrub to remove", () => {
    expect(fresh.getStaticInfo("volunteer", "en").summary).toBe("Ride along with an ambulance: call +91 70000 00008.");
  });
});

describe("numbers in fields not named for a phone (bank, UPI, IFSC)", () => {
  let fresh: typeof import("@/server/content/static");
  let tools: typeof import("@/server/agent/tools");

  beforeAll(async () => {
    fresh = await loadStaticWith({
      donate: {
        en: {
          summary: "Give through the website.", bank: "A/c 50100123456789, IFSC HDFC0001234", upi: "9876543210@upi",
          helpline_number: "+91 70000 00011", bank_account_number: "50100123456789", upi_number: "9876543210",
          ifsc_number: "0001234567", account_contact_number: "7000000014",
        },
      },
      volunteer: { en: { whatsapp: "7000000012", mobile_no: "70000 00013", contact_phone: "+91 70000 00009", contact_email: "v@example.org" } },
    });
    tools = await import("@/server/agent/tools");
  });
  afterAll(unmockStatic);

  it("tokenizes a number only in a field named for a phone, contact, mobile, helpline, WhatsApp or number", () => {
    expect(fresh.getStaticPhones()).toEqual({
      donate_helpline_number: "+917000000011",
      volunteer_whatsapp: "7000000012",
      volunteer_mobile_no: "7000000013",
      volunteer_contact_phone: "+917000000009",
    });
    expect(fresh.getStaticInfo("donate", "en")).toEqual({
      summary: "Give through the website.", bank: "A/c 50100123456789, IFSC HDFC0001234", upi: "9876543210@upi",
      helpline_number: "{{PHONE:donate_helpline_number}}", bank_account_number: "50100123456789", upi_number: "9876543210",
      ifsc_number: "0001234567", account_contact_number: "7000000014",
    });
  });

  it("never lets a bank account, IFSC or UPI number reach the model: get_info's output holds no 7+-digit run", () => {
    const ctx: ToolContext = { conversationId: "c", language: "en", registry: new HandleRegistry("c"), calls: [], lastAmbulanceCandidates: null, lastAmbulanceMatch: null };
    const out = tools.getInfoImpl(ctx, { topic: "donate" });
    expect(JSON.stringify(out)).not.toMatch(/\d(?:[\s-]?\d){6,}/);
    expect(out.helpline_number).toBe("{{PHONE:donate_helpline_number}}");
    expect(ctx.calls[0]).toMatchObject({ name: "get_info", scrubbed: true });
  });
});

describe("phone boundaries and native numerals", () => {
  let fresh: typeof import("@/server/content/static");

  beforeAll(async () => {
    fresh = await loadStaticWith({
      about: {
        en: "Animal Helpline India: 1800-419-5860 - 24x7. Steps:\n1. Call 1800-419-5860\n2. Ask a local rescue group.",
        hi: "दान के बारे में जानने के लिए १८००-४१९-५८६० पर कॉल करें। हमारे पास ४५+ एम्बुलेंस हैं।",
      },
      donate: { gu: { contact_phone: "૧૮૦૦-૪૧૯-૫૮૬૦" } },
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
    expect(fresh.getStaticInfo("about", "hi").text).toBe("दान के बारे में जानने के लिए {{PHONE:about_1}} पर कॉल करें। हमारे पास ४५+ एम्बुलेंस हैं।");
    expect(fresh.getStaticInfo("donate", "gu").contact_phone).toBe("{{PHONE:donate_contact_phone}}");
    expect(fresh.getStaticPhones()).toEqual({ about_1: "18004195860", donate_contact_phone: "18004195860" });
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
