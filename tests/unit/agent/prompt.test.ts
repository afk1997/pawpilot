import { describe, it, expect } from "vitest";
import { buildSystemPrompt, buildTurnPrompt, formatIst, type TurnContext } from "@/server/agent/prompt";

const systemPrompt = () => buildSystemPrompt({ coverage: "- Mumbai: Ghatkopar", websiteUrl: "https://arhamalwayscare.org" });

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
  it("system prompt pins the ambulance rules: any place name, confirmations, token reuse, unreachable drivers, safety line", () => {
    const p = systemPrompt();
    expect(p).toContain("as soon as you have any place name (area or city)");
    expect(p).toContain("if nothing comes back and you do not know the city, ask for it before treating the place as out of coverage");
    expect(p).toContain("the unit covers a nearby area; name that area when you confirm");
    expect(p).toContain("beyond a spelling or script fix, confirm it first");
    expect(p).toContain("A token already in the transcript stays valid: reuse it to repeat a number instead of calling the tool again");
    expect(p).toContain("If the reporter cannot reach a driver (no answer, switched off, wrong number)");
    expect(p).toContain("give another unit for that place that you have not shared yet");
    expect(p).toContain("do not move a badly injured animal; keep it calm, shaded and away from traffic");
    expect(p).not.toContain("keep it warm");
  });
  it("system prompt pins media, masked numbers, tool errors, clinic city misses, suggestions and emergency numbers", () => {
    const p = systemPrompt();
    expect(p).toContain("You cannot view photos, videos or documents");
    expect(p).toContain("A location pin without a label: ask for the area and city");
    expect(p).toContain("A labelled pin is the place to use");
    expect(p).toContain("[number sent]");
    expect(p).toContain('{"error": "lookup_failed"}');
    expect(p).toContain("city_matched false");
    expect(p).toContain("say there is no clinic in that city before listing the others");
    expect(p).toContain("noted for the team");
    expect(p).toContain("102/108/112");
  });
  it("system prompt defines the output fields and never writes a phone-shaped run", () => {
    const p = systemPrompt();
    expect(p).toContain('"location" is {"city": …, "area": …}, each null if unknown');
    expect(p).not.toContain("(null if unknown)");
    expect(p).toContain('Latin-script Hinglish → "en"');
    expect(p).toContain('Devanagari Hindi → "hi"');
    expect(p).toContain('"ambulance" when the reporter needs a unit\'s number');
    expect(p).not.toMatch(/\d(?:[ -]?\d){6,}/);
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
  it("turn prompt renders every location shape, an empty handle list and no welcome line", () => {
    const ctx: TurnContext = { nowIst: "x", language: null, knownLocation: null, handlesShared: [], welcomeJustSent: false, transcript: "t", correction: null };
    expect(buildTurnPrompt(ctx)).toContain("Location known so far: unknown\n");
    expect(buildTurnPrompt({ ...ctx, knownLocation: { city: null, area: null } })).toContain("Location known so far: unknown\n");
    expect(buildTurnPrompt({ ...ctx, knownLocation: { city: null, area: "Ghatkopar" } })).toContain("Location known so far: Ghatkopar\n");
    expect(buildTurnPrompt({ ...ctx, knownLocation: { city: "Mumbai", area: "Ghatkopar" } })).toContain("Location known so far: Ghatkopar, Mumbai\n");
    const t = buildTurnPrompt(ctx);
    expect(t).toContain("Language so far: unknown");
    expect(t).toContain("Handles already shared in this chat: none");
    expect(t).not.toContain("The welcome menu was just sent");
  });
  it("turn prompt puts the correction last, right before the closing instruction", () => {
    const t = buildTurnPrompt({
      nowIst: "x", language: "en", knownLocation: null, handlesShared: [], welcomeJustSent: true,
      transcript: "[10:03] Reporter: Surat", correction: "SYSTEM CORRECTION: fix",
    });
    expect(t).toMatch(/\n\[10:03\] Reporter: Surat\n\nSYSTEM CORRECTION: fix\nWrite the next assistant reply now\.$/);
  });
  it("formats the current time in IST, including the date roll-over after midnight", () => {
    expect(formatIst(new Date("2026-09-25T04:33:00Z"))).toMatch(/\b25\b.*2026.*\b10:03 IST$/);
    expect(formatIst(new Date("2026-09-24T18:45:00Z"))).toMatch(/\b25\b.*2026.*\b00:15 IST$/);
  });
});
