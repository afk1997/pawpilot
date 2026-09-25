import { describe, it, expect, vi } from "vitest";
import { getStaticInfo, getStaticPhones } from "@/server/content/static";

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

// The shipped volunteer phone is still TODO, so the test above cannot reach the
// tokenizing branch. A fresh module over a filled copy of the content does.
describe("phone tokenization with a filled contact phone", () => {
  it("registers the real number without a prior lookup and hands out only the token", async () => {
    vi.resetModules();
    vi.doMock("@/content/static.json", () => ({
      default: {
        volunteer: {
          en: { summary: "Volunteer with us.", contact_phone: "+91 70000 00009" },
          hi: { summary: "TODO", contact_phone: "TODO" },
        },
      },
    }));
    try {
      const fresh = await import("@/server/content/static");
      expect(fresh.getStaticPhones()).toEqual({ volunteer: "+917000000009" });
      for (const lang of ["en", "hi"] as const) {
        const c = fresh.getStaticInfo("volunteer", lang);
        expect(c.contact_phone).toBe("{{PHONE:volunteer}}");
        expect(JSON.stringify(c)).not.toMatch(/\+?\d(?:[\s-]?\d){6,}/);
      }
    } finally {
      vi.doUnmock("@/content/static.json");
      vi.resetModules();
    }
  });
});
