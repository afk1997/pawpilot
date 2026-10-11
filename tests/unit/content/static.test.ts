import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import raw from "@/content/static.json";
import { getStaticInfo, getStaticPhones, foldDigits, type InfoTopic } from "@/server/content/static";
import { LANGUAGES } from "@/server/types";
import { HandleRegistry } from "@/server/agent/handles";
import type { ToolContext } from "@/server/agent/tools";

describe("getStaticInfo", () => {
  it("returns English donate content without TODO fields, and no UPI or bank field", () => {
    const c = getStaticInfo("donate", "en");
    expect(c.summary).toMatch(/donation/i);
    expect(c.url).toBe("https://alwayscare.org/donate");
    expect(JSON.stringify(c)).not.toMatch(/TODO/);
    expect(Object.keys(c).sort()).toEqual(["summary", "tax_note", "url"]);
  });
  it("returns the Gujarati donate content in Gujarati, with the same link", () => {
    const c = getStaticInfo("donate", "gu");
    expect(c.summary).toContain("દરેક રૂપિયો સીધો જરૂરિયાતમંદ પ્રાણી સુધી પહોંચે છે");
    expect(c.url).toBe("https://alwayscare.org/donate");
  });
  it("returns FAQ as question/answer pairs, in the reporter's language", () => {
    const en = getStaticInfo("faq", "en").faq as { question: string; answer: string }[];
    expect(en.length).toBeGreaterThanOrEqual(5);
    expect(en[0].question).toMatch(/free/i);
    const hi = getStaticInfo("faq", "hi").faq as { question: string; answer: string }[];
    expect(hi).toHaveLength(en.length);
    expect(hi[0].question).toBe("क्या आपकी सेवा मुफ़्त है?");
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

describe("the website's content (2026-10-10)", () => {
  type Faq = { question: string; answer: string }[];
  const faq = (lang: (typeof LANGUAGES)[number]) => getStaticInfo("faq", lang).faq as Faq;

  it("says what the site says about us: 48 ambulances, 26+ cities, five hospitals and a clinic, free for street animals", () => {
    expect(getStaticInfo("about", "en").text).toBe(
      "Arham Always Care is the animal-rescue project of Arham Yuva Seva Group, a youth-driven Indian non-profit. We run 48 free animal ambulances with trained vets and paravets across 26+ cities, five animal hospitals and a clinic, with two more hospitals under construction. Rescue and treatment for injured street and community animals is free; for pets, call the team first."
    );
  });

  it("links the site's donate page and its volunteer section, with no volunteer contact", () => {
    for (const lang of LANGUAGES) {
      expect(getStaticInfo("donate", lang).url, lang).toBe("https://alwayscare.org/donate");
      expect(getStaticInfo("volunteer", lang).url, lang).toBe("https://alwayscare.org/#volunteer");
      expect(Object.keys(getStaticInfo("volunteer", lang)).sort(), lang).toEqual(["summary", "url"]);
    }
    expect(getStaticInfo("donate", "en").summary).toContain("Every rupee goes directly to an animal in need");
    expect(getStaticInfo("donate", "en").summary).toMatch(/once or every month.*Razorpay.*80G tax certificate.*UPI QR code/);
    expect(getStaticInfo("volunteer", "en").summary).toMatch(
      /on-ground rescue support.*social media and awareness.*fundraising and events.*a city coordinator reaches out within 48 hours/
    );
  });

  it("answers the site's FAQ: free care, what to share, Mumbai's hours, calling a hospital first, an uncovered city", () => {
    const answers = faq("en").map((e) => e.answer);
    expect(answers[0]).toMatch(/street and community animals are free.*pets.*call the team first/);
    expect(answers[1]).toMatch(/exact location, a nearby landmark.*condition/);
    expect(answers[2]).toContain("Mumbai teams answer calls 10am–7pm IST, every day.");
    expect(answers[3]).toMatch(/^Call the hospital or clinic before visiting/);
    // The hours promise is what the code does: cards show the hours the website publishes.
    expect(answers[3]).toContain("The card shows the team's hours where the website publishes them.");
    // What find_clinics and the {{MAPS:…}} token give: a facility's address and map location, on request.
    expect(answers[3]).toContain("Ask here for a hospital's or clinic's address and Google Maps location, and we will share them on this chat.");
    for (const lang of LANGUAGES) expect(faq(lang)[3].answer, lang).toContain("Google Maps");
    expect(answers[4]).toContain("Animal Helpline India at {{PHONE:faq_1}}.");
  });

  it("is written out in Hindi, Marathi and Gujarati: no field falls back to English, and digits and links stay the same", () => {
    const digitsAndLinks = (s: string) => [...(s.match(/\d+|https?:\/\/\S+/g) ?? [])].sort();
    const source = raw as unknown as Record<string, Record<string, unknown>>;
    for (const lang of ["hi", "mr", "gu"] as const) {
      for (const topic of ["donate", "volunteer"] as const) {
        const en = source[topic].en as Record<string, string>;
        const local = source[topic][lang] as Record<string, string>;
        expect(Object.keys(local).sort(), `${topic}/${lang}`).toEqual(Object.keys(en).sort());
        for (const [key, value] of Object.entries(en)) {
          if (key !== "url") expect(local[key], `${topic}.${key}/${lang}`).not.toBe(value);
          expect(digitsAndLinks(local[key]), `${topic}.${key}/${lang}`).toEqual(digitsAndLinks(value));
        }
      }
      for (const topic of ["about", "human_emergency"] as const) {
        const local = source[topic][lang] as string;
        expect(local, `${topic}/${lang}`).not.toBe(source[topic].en);
        expect(digitsAndLinks(local), `${topic}/${lang}`).toEqual(digitsAndLinks(source[topic].en as string));
      }
      faq(lang).forEach((e, i) => {
        expect(e.question, `faq ${i}/${lang}`).not.toBe(faq("en")[i].question);
        expect(e.answer, `faq ${i}/${lang}`).not.toBe(faq("en")[i].answer);
        expect(digitsAndLinks(e.answer), `faq ${i}/${lang}`).toEqual(digitsAndLinks(faq("en")[i].answer));
      });
    }
    expect(JSON.stringify(raw)).not.toMatch(/TODO/);
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

describe("unfilled translations", () => {
  let fresh: typeof import("@/server/content/static");

  beforeAll(async () => {
    fresh = await loadStaticWith({
      donate: { en: { summary: "Every rupee counts.", url: "https://alwayscare.org/donate" }, gu: { summary: "TODO", url: "TODO" } },
      about: { en: "We rescue animals.", mr: "TODO" },
    });
  });
  afterAll(unmockStatic);

  it("falls back to English for a language or field still unfilled", () => {
    expect(fresh.getStaticInfo("donate", "gu")).toEqual({ summary: "Every rupee counts.", url: "https://alwayscare.org/donate" });
    expect(fresh.getStaticInfo("about", "mr")).toEqual({ text: "We rescue animals." });
    expect(fresh.getStaticInfo("about", "hi")).toEqual({ text: "We rescue animals." });
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
