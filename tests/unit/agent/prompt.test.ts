import { describe, it, expect } from "vitest";
import { buildSystemPrompt, buildTurnPrompt, formatIst, type TurnContext } from "@/server/agent/prompt";
import { findDigitRuns } from "@/server/agent/scrub";

const systemPrompt = () => buildSystemPrompt({ coverage: "- Mumbai: Ghatkopar", websiteUrl: "https://alwayscare.org" });

describe("prompts", () => {
  it("system prompt carries identity, coverage, token grammar and safety rules", () => {
    const p = buildSystemPrompt({ coverage: "- Mumbai: Ghatkopar", websiteUrl: "https://alwayscare.org" });
    expect(p).toContain("Arham Always Care");
    expect(p).toContain("- Mumbai: Ghatkopar");
    expect(p).toContain("{{AMB:<handle>}}");
    expect(p).toContain("{{PHONE:helpline}}");
    expect(p).toMatch(/never (type|write) (phone )?digits/i);
    expect(p).toMatch(/do not dispatch|we do not dispatch|never say .*sending/i);
    expect(p).not.toMatch(/\d{7,}/);
  });
  it("system prompt covers undelivered replies, other PHONE tokens, approximate matches and bare greetings", () => {
    const p = buildSystemPrompt({ coverage: "- Mumbai: Ghatkopar", websiteUrl: "https://alwayscare.org" });
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
    expect(p).toContain('Hinglish such as "Rajkot me do units hain") → "en"');
    expect(p).toContain('Hinglish is never "hi"');
    expect(p).toContain('Devanagari Hindi → "hi"');
    expect(p).toContain('"ambulance" when the reporter needs a unit\'s number');
    expect(p).not.toMatch(/\d(?:[ -]?\d){6,}/);
  });
  it("system prompt limits needs_human to real escalation triggers", () => {
    const p = systemPrompt();
    expect(p).toContain("Set needs_human to true only when the reporter asks for a person, cannot reach a driver, complains, a tool returns lookup_failed, or the request is something this helpline cannot handle at all. An out-of-coverage place, or severe or urgent wording, never sets needs_human on its own.");
    expect(p).not.toContain("or you cannot help them");
  });
  it("system prompt pins brevity: the reporter's length, a one-line place question, no helpline description, no routine helpline number", () => {
    const p = systemPrompt();
    expect(p).toContain("Match the reporter's length: a short message gets a one- or two-line reply. Five short sentences is the maximum, never the target.");
    expect(p).toContain('When you need the place, ask for it in ONE line (for example "Aap kis city aur area mein hain? Batayein, main turant number bhejta hoon.") and add nothing else but a first-contact greeting or rule 9\'s immediate-danger line.');
    expect(p).toContain("Never describe what the helpline is or how it works unless the reporter asks about us (then answer from get_info); never repeat the menu on your own. Include {{PHONE:helpline}} only when you cannot help (out of coverage, an unreachable driver, a request for a person, a complaint, a tool error), never as a routine extra.");
    expect(p).toContain('A request for "the number" or "your number" with no place in it and none known from the conversation (for example "aapka number konsa hai") is an ambulance request: ask the city and area in one line, intent "ambulance".');
    expect(p).not.toContain("Two to five short sentences");
    // The about/FAQ rule and the no-description rule agree: a question about us is answered from get_info.
    expect(p).toContain("Donations, volunteering, about, FAQ: call get_info and answer from it");
  });
  it("system prompt says a [number sent] on an undelivered line never reached the reporter, and forbids writing the marker", () => {
    const p = systemPrompt();
    expect(p).toContain("[number sent] in the transcript stands for a phone number that was already sent, unless the line is marked [not delivered], in which case the reporter did not receive it.");
    expect(p).toContain("Never write that marker yourself");
  });
  it("turn prompt includes context lines and the transcript", () => {
    const t = buildTurnPrompt({
      nowIst: "Thu 25 Sep 2026, 10:03 IST", language: "hi", knownLocation: { city: "Mumbai", area: null },
      handlesShared: ["amb_1a2b3c4d"], firstContact: true, transcript: "[10:03] Reporter: hi", correction: null,
    });
    expect(t).toContain("Current time: Thu 25 Sep 2026, 10:03 IST");
    expect(t).toContain("Language so far: hi");
    expect(t).toContain("Location known so far: Mumbai");
    expect(t).toContain("amb_1a2b3c4d");
    expect(t).toContain('FIRST CONTACT: this is the reporter\'s first message and no welcome was sent. Open with a one-line greeting in the reporter\'s language ("Namaste!") and answer directly; do not repeat the menu or explain the helpline unless asked.');
    expect(t).toContain("[10:03] Reporter: hi");
    expect(buildTurnPrompt({ nowIst: "x", language: null, knownLocation: null, handlesShared: [], firstContact: false, transcript: "t", correction: "SYSTEM CORRECTION: fix" })).toContain("SYSTEM CORRECTION: fix");
  });
  it("turn prompt renders every location shape, an empty handle list and no first-contact line", () => {
    const ctx: TurnContext = { nowIst: "x", language: null, knownLocation: null, handlesShared: [], firstContact: false, transcript: "t", correction: null };
    expect(buildTurnPrompt(ctx)).toContain("Location known so far: unknown\n");
    expect(buildTurnPrompt({ ...ctx, knownLocation: { city: null, area: null } })).toContain("Location known so far: unknown\n");
    expect(buildTurnPrompt({ ...ctx, knownLocation: { city: null, area: "Ghatkopar" } })).toContain("Location known so far: Ghatkopar\n");
    expect(buildTurnPrompt({ ...ctx, knownLocation: { city: "Mumbai", area: "Ghatkopar" } })).toContain("Location known so far: Ghatkopar, Mumbai\n");
    const t = buildTurnPrompt(ctx);
    expect(t).toContain("Language so far: unknown");
    expect(t).toContain("Handles already shared in this chat: none");
    expect(t).not.toContain("FIRST CONTACT");
  });
  it("turn prompt lists pre-matched units with their tokens, after the context and before the transcript", () => {
    const ctx: TurnContext = { nowIst: "x", language: "en", knownLocation: null, handlesShared: [], firstContact: false, transcript: "[10:03] Reporter: ghatkopar", correction: null };
    const arham = { handle: "amb_kcmfpbca", display_name: "Arham Animal Ambulance, Ghatkopar", city: "Mumbai", area: "Ghatkopar", operator_name: "Arham Yuva Seva Group", operator_is_arham: true };
    const partner = { handle: "amb_pbcdefgh", display_name: "Animal Ambulance, Rajkot", city: "Rajkot", area: null, operator_name: "Blue Cross", operator_is_arham: false };
    const header = "PRE-MATCHED UNITS (the system already looked up the reporter's words; use these handles directly — do not call find_ambulances again unless the reporter means a different place)";
    expect(buildTurnPrompt({ ...ctx, prematched: { matchType: "area", source: "words", units: [arham] } })).toContain(
      `Handles already shared in this chat: none\n\n${header}\n- {{AMB:amb_kcmfpbca}} — Arham Animal Ambulance, Ghatkopar (Mumbai) [match: area]\n\nTRANSCRIPT\n`
    );
    expect(buildTurnPrompt({ ...ctx, prematched: { matchType: "city", source: "words", units: [partner, { ...partner, handle: "amb_ponmlkji", operator_name: "Hope for Indies Trust" }] } })).toContain(
      `${header}\n- {{AMB:amb_pbcdefgh}} — Animal Ambulance, Rajkot (Rajkot), operated by Blue Cross [match: city]\n- {{AMB:amb_ponmlkji}} — Animal Ambulance, Rajkot (Rajkot), operated by Hope for Indies Trust [match: city]\n\nTRANSCRIPT\n`
    );
    for (const prematched of [undefined, null]) expect(buildTurnPrompt({ ...ctx, prematched })).not.toContain("PRE-MATCHED UNITS");
  });

  it("turn prompt names the covered area an area match went through, before a partner's operator", () => {
    const ctx: TurnContext = { nowIst: "x", language: "en", knownLocation: null, handlesShared: [], firstContact: false, transcript: "t", correction: null };
    const unit = { handle: "amb_kcmfpbca", display_name: "Arham Animal Ambulance, Ghatkopar", city: "Mumbai", area: "Ghatkopar", operator_name: "Arham Yuva Seva Group", operator_is_arham: true };
    expect(buildTurnPrompt({ ...ctx, prematched: { matchType: "area", source: "words", units: [{ ...unit, covers: "Vikhroli" }] } })).toContain(
      "- {{AMB:amb_kcmfpbca}} — Arham Animal Ambulance, Ghatkopar (Mumbai), covers Vikhroli [match: area]\n"
    );
    const partner = { ...unit, display_name: "Animal Ambulance, Rajkot", city: "Rajkot", area: null, operator_name: "Blue Cross", operator_is_arham: false, covers: "Gondal Road" };
    expect(buildTurnPrompt({ ...ctx, prematched: { matchType: "area", source: "words", units: [partner] } })).toContain(
      "- {{AMB:amb_kcmfpbca}} — Animal Ambulance, Rajkot (Rajkot), covers Gondal Road, operated by Blue Cross [match: area]\n"
    );
    expect(buildTurnPrompt({ ...ctx, prematched: { matchType: "area", source: "words", units: [{ ...unit, covers: null }] } })).toContain(
      "- {{AMB:amb_kcmfpbca}} — Arham Animal Ambulance, Ghatkopar (Mumbai) [match: area]\n"
    );
  });

  it("turn prompt says when the pre-matched units are for the location known so far, not the reporter's words", () => {
    const t = buildTurnPrompt({
      nowIst: "x", language: "en", knownLocation: { city: "Mumbai", area: "Ghatkopar" }, handlesShared: [], firstContact: false, transcript: "t", correction: null,
      prematched: {
        matchType: "area", source: "known_location",
        units: [{ handle: "amb_kcmfpbca", display_name: "Arham Animal Ambulance, Ghatkopar", city: "Mumbai", area: "Ghatkopar", operator_name: "Arham Yuva Seva Group", operator_is_arham: true }],
      },
    });
    expect(t).toContain(
      "PRE-MATCHED UNITS (the system looked up the location known so far (Ghatkopar, Mumbai), not the reporter's new words, which the code could not match to a place; use these handles only if the reporter still needs a unit there — for any other place call find_ambulances)\n" +
        "- {{AMB:amb_kcmfpbca}} — Arham Animal Ambulance, Ghatkopar (Mumbai) [match: area]\n"
    );
    expect(t).not.toContain("looked up the reporter's words");
  });

  it("turn prompt drops a phone-shaped run from the known location, on its line and in the known-location header, tokens untouched", () => {
    const unit = {
      handle: "amb_kcmfpbca", display_name: "Arham Animal Ambulance, Sitabuldi", city: "Nagpur", area: "Sitabuldi",
      operator_name: "Arham Yuva Seva Group", operator_is_arham: true,
    };
    const t = buildTurnPrompt({
      nowIst: "x", language: "en", handlesShared: ["amb_kcmfpbca"], firstContact: false, correction: null,
      // A City cell holding a number, and an area with one in Devanagari digits.
      knownLocation: { city: "Nagpur 98765 00123", area: "Sitabuldi ९८७६५-००१२४" },
      transcript: "[10:03] System: Arham Animal Ambulance, Sitabuldi\n  {{AMB:amb_kcmfpbca}}\n  Please call them right away.",
      prematched: { matchType: "area", source: "known_location", units: [unit] },
    });
    expect(t).toContain("Location known so far: Sitabuldi, Nagpur\n");
    expect(t).toContain("PRE-MATCHED UNITS (the system looked up the location known so far (Sitabuldi, Nagpur), not the reporter's new words");
    expect(findDigitRuns(t)).toEqual([]);
    // The token grammar is untouched: the handle list, the pre-matched line and the transcript's token as written.
    expect(t).toContain("Handles already shared in this chat: amb_kcmfpbca\n");
    expect(t).toContain("- {{AMB:amb_kcmfpbca}} — Arham Animal Ambulance, Sitabuldi (Nagpur) [match: area]\n");
    expect(t).toContain("  {{AMB:amb_kcmfpbca}}\n");
    // A location that is only a number is no location.
    expect(buildTurnPrompt({ nowIst: "x", language: null, knownLocation: { city: "98765 00123", area: null }, handlesShared: [], firstContact: false, transcript: "t", correction: null }))
      .toContain("Location known so far: unknown\n");
  });

  it("turn prompt puts the correction last, right before the closing instruction", () => {
    const t = buildTurnPrompt({
      nowIst: "x", language: "en", knownLocation: null, handlesShared: [], firstContact: true,
      transcript: "[10:03] Reporter: Surat", correction: "SYSTEM CORRECTION: fix",
    });
    expect(t).toMatch(/\n\[10:03\] Reporter: Surat\n\nSYSTEM CORRECTION: fix\nWrite the next assistant reply now\.$/);
  });
  it("formats the current time in IST, including the date roll-over after midnight", () => {
    expect(formatIst(new Date("2026-09-25T04:33:00Z"))).toMatch(/\b25\b.*2026.*\b10:03 IST$/);
    expect(formatIst(new Date("2026-09-24T18:45:00Z"))).toMatch(/\b25\b.*2026.*\b00:15 IST$/);
  });
});
