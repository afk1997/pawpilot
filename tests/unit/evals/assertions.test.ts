import { describe, it, expect } from "vitest";
import { checkStep } from "../../../evals/assertions";

const actual = (content: string, extra: Partial<Parameters<typeof checkStep>[1]> = {}) => ({
  messages: [{ content }], turnStatus: "ok", structured: { reply: content, language: "hi" as const, intent: "ambulance" as const, location: { city: null, area: null }, needs_human: false, notes: null },
  flagged: false, outcomeKind: "ok", knownNumbers: new Map([["Mumbai - Ghatkopar", "+917000000001"]]), allowedNumbers: ["+917000000001"], ...extra,
});

describe("checkStep", () => {
  it("passes a correct reply", () => {
    expect(checkStep({ contains: ["Ghatkopar"], number_of: ["Mumbai - Ghatkopar"], language: "hi", intent: "ambulance", no_foreign_digits: true, no_dispatch: true, turn_status: "ok" }, actual("Ghatkopar ambulance: +91 70000 00001"))).toEqual([]);
  });
  it("reports each failure", () => {
    const fails = checkStep({ number_of: ["Mumbai - Ghatkopar"], no_foreign_digits: true, no_dispatch: true, language: "gu", flagged: true }, actual("We are sending 9999988888 now"));
    expect(fails.some((f) => f.includes("number_of"))).toBe(true);
    expect(fails.some((f) => f.includes("foreign digits"))).toBe(true);
    expect(fails.some((f) => f.includes("dispatch"))).toBe(true);
    expect(fails.some((f) => f.includes("language"))).toBe(true);
    expect(fails.some((f) => f.includes("flagged"))).toBe(true);
  });
  it("checks language by script when the structured output is missing", () => {
    expect(checkStep({ language: "gu" }, actual("સુરત", { structured: null }))).toEqual([]);
  });
});
