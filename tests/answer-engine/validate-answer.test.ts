import { describe, expect, it } from "vitest";
import { validateAnswer } from "../../src/lib/answer-engine/validate-answer";
import type { EvidencePack } from "../../src/lib/answer-engine/types";

function evidence(overrides: Partial<EvidencePack> = {}): EvidencePack {
  return {
    intent: "donation",
    language: "en",
    confidence: "high",
    deterministicFacts: [],
    officialLinks: [{ key: "donate", label: "Donate", url: "https://www.alwayscare.org/donate" }],
    articles: [],
    templates: [],
    forbiddenClaims: [],
    validationContext: {
      allowedPhoneNumbers: ["+91 90900 10153"],
      allowedUrls: ["https://www.alwayscare.org/donate"],
      allowedFactKeys: [],
    },
    ...overrides,
  };
}

describe("validateAnswer", () => {
  it("rejects phone numbers that are not present in evidence", () => {
    const result = validateAnswer({
      answer: "Call +91 99999 99999 for help.",
      intent: "contact",
      evidence: evidence({ intent: "contact" }),
    });

    expect(result.valid).toBe(false);
    expect(result.warnings).toContain("unauthorized_phone_number");
  });

  it("rejects URLs that are not present in evidence", () => {
    const result = validateAnswer({
      answer: "Donate here: https://fake.example/donate",
      intent: "donation",
      evidence: evidence(),
    });

    expect(result.valid).toBe(false);
    expect(result.warnings).toContain("unauthorized_url");
  });

  it("rejects dispatch promises and placeholder text", () => {
    const result = validateAnswer({
      answer: "We're sending the team now. TODO: add phone.",
      intent: "emergency",
      evidence: evidence({ intent: "emergency" }),
    });

    expect(result.valid).toBe(false);
    expect(result.warnings).toEqual(
      expect.arrayContaining(["unsafe_dispatch_language", "placeholder_content"])
    );
  });

  it("accepts answers composed only from allowed evidence", () => {
    const result = validateAnswer({
      answer: "You can donate here:\nhttps://www.alwayscare.org/donate",
      intent: "donation",
      evidence: evidence(),
    });

    expect(result.valid).toBe(true);
    expect(result.warnings).toEqual([]);
  });
});
