import { describe, it, expect } from "vitest";
import { buildSystemPrompt, buildTurnPrompt, formatIst } from "@/server/agent/prompt";

describe("prompts", () => {
  it("system prompt carries identity, coverage, token grammar and safety rules", () => {
    const p = buildSystemPrompt({ coverage: "- Mumbai: Ghatkopar", websiteUrl: "https://arhamalwayscare.org" });
    expect(p).toContain("Arham Always Care");
    expect(p).toContain("- Mumbai: Ghatkopar");
    expect(p).toContain("{{AMB:<handle>}}");
    expect(p).toContain("{{PHONE:helpline}}");
    expect(p).toMatch(/never (type|write) (phone )?digits/i);
    expect(p).toMatch(/do not dispatch|we do not dispatch|never say .*sending/i);
    expect(p).not.toMatch(/\d{7,}/);
  });
  it("system prompt covers undelivered replies, other PHONE tokens, approximate matches and bare greetings", () => {
    const p = buildSystemPrompt({ coverage: "- Mumbai: Ghatkopar", websiteUrl: "https://arhamalwayscare.org" });
    expect(p).toContain("A transcript line marked [not delivered] never reached the reporter");
    expect(p).toContain("{{PHONE:<key>}}");
    expect(p).toMatch(/copy .*exactly as returned/i);
    expect(p).toContain('match "fuzzy" or "neighbour"');
    expect(p).toContain("never the menu again, never a repeated welcome");
  });
  it("turn prompt includes context lines and the transcript", () => {
    const t = buildTurnPrompt({
      nowIst: "Thu 25 Sep 2026, 10:03 IST", language: "hi", knownLocation: { city: "Mumbai", area: null },
      handlesShared: ["amb_1a2b3c4d"], welcomeJustSent: true, transcript: "[10:03] Reporter: hi", correction: null,
    });
    expect(t).toContain("Current time: Thu 25 Sep 2026, 10:03 IST");
    expect(t).toContain("Language so far: hi");
    expect(t).toContain("Location known so far: Mumbai");
    expect(t).toContain("amb_1a2b3c4d");
    expect(t).toContain("The welcome menu was just sent");
    expect(t).toContain("[10:03] Reporter: hi");
    expect(buildTurnPrompt({ nowIst: "x", language: null, knownLocation: null, handlesShared: [], welcomeJustSent: false, transcript: "t", correction: "SYSTEM CORRECTION: fix" })).toContain("SYSTEM CORRECTION: fix");
  });
  it("formats the current time in IST, including the date roll-over after midnight", () => {
    expect(formatIst(new Date("2026-09-25T04:33:00Z"))).toMatch(/\b25\b.*2026.*\b10:03 IST$/);
    expect(formatIst(new Date("2026-09-24T18:45:00Z"))).toMatch(/\b25\b.*2026.*\b00:15 IST$/);
  });
});
