import { describe, expect, it } from "vitest";
import { classifyIntent } from "../../src/lib/answer-engine/classify-intent";

describe("classifyIntent", () => {
  it("classifies donation and 80G questions without an LLM", () => {
    const result = classifyIntent("Do I get 80G certificate if I donate?");

    expect(result.intent).toBe("donation");
    expect(result.confidence).toBe("high");
    expect(result.reason).toContain("donation");
  });

  it("classifies medical advice requests as refusal-safe", () => {
    const result = classifyIntent("What medicine dosage can I give an injured dog?");

    expect(result.intent).toBe("medical_advice");
    expect(result.confidence).toBe("high");
  });

  it("extracts location hints for emergency ambulance requests", () => {
    const result = classifyIntent("There is a bleeding dog in Mumbai Ghatkopar");

    expect(result.intent).toBe("emergency");
    expect(result.extractedLocation?.city).toBe("Mumbai");
    expect(result.extractedLocation?.area).toBe("Ghatkopar");
  });

  it("extracts Devanagari city and area aliases", () => {
    const result = classifyIntent("मुंबई घाटकोपर में घायल कुत्ता है, ambulance चाहिए");

    expect(result.intent).toBe("emergency");
    expect(result.extractedLocation?.city).toBe("Mumbai");
    expect(result.extractedLocation?.area).toBe("Ghatkopar");
  });

  it("extracts Gujarati city and area aliases", () => {
    const result = classifyIntent("મુંબઈ ઘાટકોપર માં કૂતરો ઇજાગ્રસ્ત છે");

    expect(result.intent).toBe("emergency");
    expect(result.extractedLocation?.city).toBe("Mumbai");
    expect(result.extractedLocation?.area).toBe("Ghatkopar");
  });
});
