import { describe, it, expect } from "vitest";
import { guardReply, type GuardDeps } from "@/server/agent/guards";
import { HandleRegistry } from "@/server/agent/handles";
import type { StructuredReply } from "@/server/agent/types";
import type { DirectoryAmbulance, MatchType } from "@/server/directory/matcher";
import type { DirectoryClinic } from "@/server/directory/repo";
import { findDigitRuns, hasDispatchLanguage } from "@/server/agent/scrub";
import { buildHelplineCard } from "@/server/messages/cards";
import { DISPATCH_CORRECTION_NOTE, LINK_CORRECTION_NOTE, TOKEN_CORRECTION_NOTE, staleHandleNote } from "@/server/messages/system-replies";

const ghatkopar: DirectoryAmbulance = {
  id: "g", label: "Mumbai - Ghatkopar", city: "Mumbai", area: "Ghatkopar", state: "MH", areasCovered: [], category: "Animal Ambulance",
  phone: "+917000000001", operatorName: "Arham Yuva Seva Group", operatorIsArham: true,
};
const rajkot: DirectoryAmbulance = { ...ghatkopar, id: "r", label: "Rajkot - Blue Cross", city: "Rajkot", area: null, phone: "+919876500001", operatorName: "Blue Cross", operatorIsArham: false };
const units: Record<string, DirectoryAmbulance> = { g: ghatkopar, r: rajkot };
/** A map link with 5-decimal coordinates, as the directory writes them: no 7-digit run. */
const GHATKOPAR_MAP = "https://maps.google.com/?q=19.07948,72.90119";
/** A stored value with seven decimals: each group a 7-digit run. MAPS_URL_RE refuses it, so it is never inserted. */
const LONG_MAP = "https://maps.google.com/?q=19.0794812,72.9011934";
/** A website link whose words would read as dispatch language if the dispatch guard read links. */
const WORDY_PAGE = "https://alwayscare.org/ambulance-dispatched-we-are-sending";
const hospital: DirectoryClinic = {
  id: "h", label: "Mumbai - Ghatkopar Hospital", city: "Mumbai", area: "Ghatkopar", state: "MH", phone: "+917000000020", address: null, hours: null,
  mapsUrl: GHATKOPAR_MAP,
};
/** Hospitals and clinics by id; any other id is retired. */
const facilities: Record<string, DirectoryClinic> = {
  h: hospital,
  l: { ...hospital, id: "l", phone: "+917000000021", mapsUrl: LONG_MAP },
  n: { ...hospital, id: "n", phone: "+917000000023", mapsUrl: null },
};
const CALL_DIRECTLY = "Please call them directly and they will guide you.";

const HELPLINE_CARD = buildHelplineCard("+919999900000", "en");
const HELPLINE_TEMPLATE = HELPLINE_CARD.replace("+91 99999 00000", "{{PHONE:helpline}}");

const reply = (partial: Partial<StructuredReply> & { reply: string }): StructuredReply => ({
  language: "en", intent: "other", location: { city: null, area: null }, needs_human: false, notes: null, ...partial,
});

/** Guard deps over the two units above: `active` limits which ids resolve, `corrected` scripts the corrective calls. */
function setup(opts: {
  corrected?: (StructuredReply | null)[];
  active?: string[];
  candidates?: DirectoryAmbulance[];
  match?: MatchType | null;
  toolRuns?: string[];
} = {}) {
  const registry = new HandleRegistry("conv");
  const active = new Set(opts.active ?? Object.keys(units));
  const corrected = [...(opts.corrected ?? [])];
  const corrections: { correction: string; purpose: string }[] = [];
  const deps: GuardDeps = {
    registry,
    lookups: { ambulance: async (id) => (active.has(id) ? units[id] : undefined), clinic: async (id) => facilities[id] },
    helplinePhone: "+919999900000",
    staticPhones: { volunteer: "+919888800000" },
    websiteUrl: "https://alwayscare.org",
    toolState: () => ({ candidates: opts.candidates ?? null, match: opts.match ?? null }),
    toolRuns: () => opts.toolRuns ?? [],
    retry: async (correction, purpose) => {
      corrections.push({ correction, purpose });
      return corrected.length > 0 ? corrected.shift()! : null;
    },
  };
  return { registry, deps, corrections };
}

describe("guardReply", () => {
  it("passes a clean reply through, rendered, with no corrective call", async () => {
    const { registry, deps, corrections } = setup();
    const h = registry.ambulance("g");
    const g = await guardReply(reply({ reply: `Call {{AMB:${h}}} now.` }), deps);
    expect(g).toMatchObject({
      text: "Call +91 70000 00001 now.", template: `Call {{AMB:${h}}} now.`,
      scrubbed: false, replaced: false, restored: 0, unknownHandles: [], staleHandles: [], droppedSyntax: [],
    });
    expect(corrections).toEqual([]);
  });

  it("corrects typed digits once, native numerals included, then strips what is still typed from the text and the template", async () => {
    const { deps, corrections } = setup({ corrected: [reply({ reply: "Ring 98765 43210 or {{PHONE:helpline}}." })] });
    const g = await guardReply(reply({ reply: "Call ९८७६५४३२१० now." }), deps);
    expect(corrections).toEqual([{ correction: TOKEN_CORRECTION_NOTE, purpose: "token" }]);
    expect(g).toMatchObject({ text: "Ring or +91 99999 00000.", template: "Ring or {{PHONE:helpline}}.", scrubbed: true, foreignRuns: 1, digitDrops: 0 });
  });

  it("strips the draft it has when the corrective call brings nothing", async () => {
    const { deps, corrections } = setup();
    const g = await guardReply(reply({ reply: "Call 9876543210 now." }), deps);
    expect(corrections).toHaveLength(1);
    expect(g).toMatchObject({ text: "Call now.", template: "Call now.", scrubbed: true, foreignRuns: 1 });
  });

  it("allows the runs this turn's tools returned", async () => {
    const { deps, corrections } = setup({ toolRuns: ["12345678"] });
    const g = await guardReply(reply({ reply: "We have helped 12345678 animals." }), deps);
    expect(corrections).toEqual([]);
    expect(g).toMatchObject({ text: "We have helped 12345678 animals.", scrubbed: false });
  });

  it("stores a number the model retyped as its token and any other allowed run as a marker, never as digits", async () => {
    const { registry, deps, corrections } = setup({ toolRuns: ["12345678"] });
    const h = registry.ambulance("r");
    const g = await guardReply(reply({ reply: `Call {{AMB:${h}}}, that is 98765 00001. We have helped 12345678 animals.` }), deps);
    expect(corrections).toEqual([]);
    expect(g).toMatchObject({
      text: "Call +91 98765 00001 (operated by Blue Cross), that is 98765 00001. We have helped 12345678 animals.",
      template: `Call {{AMB:${h}}}, that is {{AMB:${h}}}. We have helped [number sent] animals.`,
      scrubbed: false,
    });
  });

  it("reports only handle-shaped drops, counts the ones holding digits, and keeps dropped syntax apart", async () => {
    const written = "Call {{AMB:amb_pppppppp}} or {{AMB:amb_zzzzzzzz}} or {AMB:x} or {{PHONE:98765}} now.";
    const { deps, corrections } = setup({ corrected: [reply({ reply: written })] });
    const g = await guardReply(reply({ reply: written }), deps);
    expect(corrections).toHaveLength(1);
    // Every token dropped and no number left: the helpline card follows.
    expect(g).toMatchObject({
      text: `Call or or or now.\n\n${HELPLINE_CARD}`, template: `Call or or or now.\n\n${HELPLINE_TEMPLATE}`, scrubbed: true, foreignRuns: 0,
      digitDrops: 1, unknownHandles: ["amb_pppppppp"], droppedSyntax: ["{AMB:x}"],
    });
  });

  it("asks for a fresh lookup, naming the retired handle, and reports it as stale if it stays", async () => {
    const { registry, deps, corrections } = setup({ active: ["r"] });
    const h = registry.ambulance("g");
    const g = await guardReply(reply({ reply: `Number: {{AMB:${h}}}` }), deps);
    // Only the stale note: nothing in the draft was typed as digits.
    expect(corrections).toEqual([{ correction: staleHandleNote([h]), purpose: "token" }]);
    expect(g).toMatchObject({ text: `Number:\n\n${HELPLINE_CARD}`, staleHandles: [h], unknownHandles: [], scrubbed: false, restored: 0 });
  });

  it("sends both notes when a draft typed digits and used a retired handle", async () => {
    const { registry, deps, corrections } = setup({ active: ["r"] });
    const h = registry.ambulance("g");
    await guardReply(reply({ reply: `Call 9876543210 or {{AMB:${h}}}.` }), deps);
    expect(corrections).toEqual([{ correction: `${TOKEN_CORRECTION_NOTE} ${staleHandleNote([h])}`, purpose: "token" }]);
  });

  it("appends the helpline card after an invented handle leaves a reply of any intent with no number", async () => {
    const { deps, corrections } = setup();
    const g = await guardReply(reply({ reply: "Call {{AMB:amb_pppppppp}} now.", intent: "other" }), deps);
    expect(corrections).toEqual([]);
    expect(g).toMatchObject({ text: `Call now.\n\n${HELPLINE_CARD}`, template: `Call now.\n\n${HELPLINE_TEMPLATE}`, unknownHandles: ["amb_pppppppp"] });
  });

  it("appends it after a retired clinic's handle in a clinic reply, and names find_clinics in the correction", async () => {
    const { registry, deps, corrections } = setup();
    const c = registry.clinic("c1");
    const g = await guardReply(reply({ reply: `The clinic's number: {{CLINIC:${c}}}`, intent: "clinic" }), deps);
    expect(corrections).toEqual([{ correction: staleHandleNote([c]), purpose: "token" }]);
    expect(corrections[0].correction).toContain("find_clinics");
    expect(g).toMatchObject({ text: `The clinic's number:\n\n${HELPLINE_CARD}`, staleHandles: [c] });
  });

  it("appends it after a retired handle that first appears in the dispatch-corrected draft", async () => {
    const { registry, deps, corrections } = setup({ active: ["r"] });
    const h = registry.ambulance("g");
    deps.retry = async (correction, purpose) => {
      corrections.push({ correction, purpose });
      return reply({ reply: `Please call {{AMB:${h}}}.`, intent: "ambulance" });
    };
    const g = await guardReply(reply({ reply: "We are sending an ambulance now.", intent: "ambulance" }), deps);
    expect(corrections.map((c) => c.purpose)).toEqual(["dispatch"]);
    expect(g).toMatchObject({ text: `Please call.\n\n${HELPLINE_CARD}`, staleHandles: [h], replaced: false });
  });

  it("appends no helpline card when a dropped handle sits beside a number that reaches the reporter", async () => {
    const { deps } = setup();
    const g = await guardReply(reply({ reply: "Call {{AMB:amb_pppppppp}} or {{PHONE:helpline}}.", intent: "other" }), deps);
    expect(g.text).toBe("Call or +91 99999 00000.");
  });

  it("appends the helpline card when a stale handle leaves an ambulance reply with no number", async () => {
    const { registry, deps, corrections } = setup({ active: ["r"] });
    const h = registry.ambulance("g");
    const g = await guardReply(reply({ reply: `Is number par call karein: {{AMB:${h}}}`, intent: "ambulance", language: "hi" }), deps);
    expect(corrections).toHaveLength(1);
    const card = buildHelplineCard("+919999900000", "hi");
    expect(g).toMatchObject({
      text: `Is number par call karein:\n\n${card}`,
      template: `Is number par call karein:\n\n${card.replace("+91 99999 00000", "{{PHONE:helpline}}")}`,
      staleHandles: [h], restored: 0,
    });
  });

  it("appends it too when the corrected reply drops the retired unit but still gives no number", async () => {
    const { registry, deps } = setup({ active: ["r"], corrected: [reply({ reply: "Which area are you in?", intent: "ambulance" })] });
    const h = registry.ambulance("g");
    const g = await guardReply(reply({ reply: `Number: {{AMB:${h}}}`, intent: "ambulance" }), deps);
    expect(g).toMatchObject({ text: `Which area are you in?\n\n${buildHelplineCard("+919999900000", "en")}`, staleHandles: [] });
  });

  it("appends no helpline card when a number still reaches the reporter", async () => {
    const { registry, deps } = setup({ active: ["r"], corrected: [reply({ reply: "Please call our helpline {{PHONE:helpline}}.", intent: "ambulance" })] });
    const h = registry.ambulance("g");
    const g = await guardReply(reply({ reply: `Number: {{AMB:${h}}}`, intent: "ambulance" }), deps);
    expect(g.text).toBe("Please call our helpline +91 99999 00000.");
    const both = setup({ active: ["r"] });
    const stale = both.registry.ambulance("g");
    const live = both.registry.ambulance("r");
    const g2 = await guardReply(reply({ reply: `Call {{AMB:${live}}} (the other one, {{AMB:${stale}}}, is off duty).`, intent: "ambulance" }), both.deps);
    expect(g2.text).toContain("+91 98765 00001");
    expect(g2.text).not.toContain("99999 00000");
  });

  it("replaces dispatch language after one correction, keeping the number, its partner label and its token", async () => {
    const { registry, deps, corrections } = setup();
    const h = registry.ambulance("r");
    const g = await guardReply(reply({ reply: `We are sending {{AMB:${h}}} to you now. Stay calm.` }), deps);
    expect(corrections).toEqual([{ correction: DISPATCH_CORRECTION_NOTE, purpose: "dispatch" }]);
    expect(g).toMatchObject({
      text: `${CALL_DIRECTLY} +91 98765 00001 (operated by Blue Cross) Stay calm.`,
      template: `${CALL_DIRECTLY} {{AMB:${h}}} Stay calm.`,
      replaced: true, restored: 0,
    });
  });

  it("runs the digit guard on the dispatch correction's draft", async () => {
    const { deps, corrections } = setup({ corrected: [reply({ reply: "Call 9876543210 or {{PHONE:helpline}}." })] });
    const g = await guardReply(reply({ reply: "The ambulance is on its way." }), deps);
    expect(corrections.map((c) => c.purpose)).toEqual(["dispatch"]);
    expect(g).toMatchObject({ text: "Call or +91 99999 00000.", template: "Call or {{PHONE:helpline}}.", scrubbed: true, replaced: false });
  });

  it("sends again, with its partner label and its token, a number an earlier draft inserted that the corrected reply lacks", async () => {
    const { registry, deps } = setup({ corrected: [reply({ reply: "Please call the Rajkot ambulance." })] });
    const h = registry.ambulance("r");
    const g = await guardReply(reply({ reply: `Call {{AMB:${h}}} or 9876543210.` }), deps);
    expect(g).toMatchObject({
      text: `Please call the Rajkot ambulance.\n\n${CALL_DIRECTLY} +91 98765 00001 (operated by Blue Cross)`,
      template: `Please call the Rajkot ambulance.\n\n${CALL_DIRECTLY} {{AMB:${h}}}`,
      restored: 1, scrubbed: false,
    });
  });

  it("keeps needs_human once any draft set it, and then appends no guessed card", async () => {
    const ambulanceReply = reply({ reply: "Please call the Ghatkopar ambulance.", intent: "ambulance" });
    const control = setup({ candidates: [ghatkopar], match: "area" });
    expect((await guardReply(ambulanceReply, control.deps)).text).toContain("Arham Animal Ambulance, Ghatkopar\n+91 70000 00001");
    const { deps } = setup({ candidates: [ghatkopar], match: "area", corrected: [ambulanceReply] });
    const g = await guardReply(reply({ reply: "Call 9876543210.", intent: "ambulance", needs_human: true }), deps);
    expect(g.text).toBe("Please call the Ghatkopar ambulance.");
    expect(g.structured).toMatchObject({ reply: "Please call the Ghatkopar ambulance.", needs_human: true });
  });

  it("passes an inserted map link through: no corrective call, the link whole in the text, its token in the template", async () => {
    // 5-decimal coordinates hold no phone-shaped run in the first place.
    expect(findDigitRuns(GHATKOPAR_MAP)).toEqual([]);
    const { registry, deps, corrections } = setup();
    const h = registry.clinic("h");
    const g = await guardReply(reply({ reply: `Ghatkopar hospital: {{CLINIC:${h}}}. Google Maps: {{MAPS:${h}}}`, intent: "clinic" }), deps);
    expect(corrections).toEqual([]);
    expect(g).toMatchObject({
      text: `Ghatkopar hospital: +91 70000 00020. Google Maps: ${GHATKOPAR_MAP}`,
      template: `Ghatkopar hospital: {{CLINIC:${h}}}. Google Maps: {{MAPS:${h}}}`,
      scrubbed: false, foreignRuns: 0, replaced: false, restored: 0, unknownHandles: [], staleHandles: [],
    });
  });

  it("never inserts a stored map value with seven decimals, so no inserted link holds a 7-digit run: the token goes", async () => {
    expect(findDigitRuns(LONG_MAP)).not.toEqual([]);
    const { registry, deps, corrections } = setup();
    const l = registry.clinic("l");
    const g = await guardReply(reply({ reply: `Google Maps: {{MAPS:${l}}}`, intent: "clinic" }), deps);
    expect(corrections).toEqual([]);
    expect(g).toMatchObject({ text: `Google Maps:\n\n${HELPLINE_CARD}`, unknownHandles: [l], scrubbed: false, foreignRuns: 0 });
    expect(g.text).not.toContain("0794812");
  });

  it("still strips a number the model typed beside an inserted link, never touching the link", async () => {
    const { registry, deps, corrections } = setup();
    const h = registry.clinic("h");
    const g = await guardReply(reply({ reply: `Google Maps: {{MAPS:${h}}}, or call 98765 43210.`, intent: "clinic" }), deps);
    expect(corrections).toEqual([{ correction: TOKEN_CORRECTION_NOTE, purpose: "token" }]);
    expect(g).toMatchObject({ text: `Google Maps: ${GHATKOPAR_MAP}, or call.`, template: `Google Maps: {{MAPS:${h}}}, or call.`, scrubbed: true, foreignRuns: 1 });
  });

  it("never reads a link's words as dispatch language", async () => {
    expect(hasDispatchLanguage("The ambulance is dispatched.")).toBe(true);
    expect(hasDispatchLanguage(`See ${WORDY_PAGE}`)).toBe(false);
    const { deps, corrections } = setup();
    const g = await guardReply(reply({ reply: `See ${WORDY_PAGE} for the hospitals.`, intent: "clinic" }), deps);
    expect(corrections).toEqual([]);
    expect(g).toMatchObject({ text: `See ${WORDY_PAGE} for the hospitals.`, replaced: false });
  });

  it("keeps the link a replaced dispatch sentence held, after the call-directly line, its token in the template", async () => {
    const { registry, deps, corrections } = setup();
    const h = registry.clinic("h");
    const g = await guardReply(reply({ reply: `We are sending the team to {{MAPS:${h}}} now. Stay calm.`, intent: "clinic" }), deps);
    expect(corrections).toEqual([{ correction: DISPATCH_CORRECTION_NOTE, purpose: "dispatch" }]);
    expect(g).toMatchObject({
      text: `${CALL_DIRECTLY} ${GHATKOPAR_MAP} Stay calm.`,
      template: `${CALL_DIRECTLY} {{MAPS:${h}}} Stay calm.`,
      replaced: true,
    });
  });

  it("drops a MAPS token for a facility without a map link as an unknown handle's, with the helpline card when no number is left", async () => {
    const { registry, deps, corrections } = setup();
    const n = registry.clinic("n");
    const g = await guardReply(reply({ reply: `Google Maps: {{MAPS:${n}}}`, intent: "clinic" }), deps);
    expect(corrections).toEqual([]);
    expect(g).toMatchObject({
      text: `Google Maps:\n\n${HELPLINE_CARD}`, template: `Google Maps:\n\n${HELPLINE_TEMPLATE}`, unknownHandles: [n], staleHandles: [],
    });
    // With the facility's number in the reply, the number is what the reporter gets: no helpline card.
    const withNumber = await guardReply(reply({ reply: `Call {{CLINIC:${n}}}. Google Maps: {{MAPS:${n}}}`, intent: "clinic" }), deps);
    expect(withNumber).toMatchObject({ text: "Call +91 70000 00023. Google Maps:", template: `Call {{CLINIC:${n}}}. Google Maps:` });
  });

  it("counts malformed map syntax ({MAP:…}) as a dropped map token: the helpline card when no number is left", async () => {
    const { deps } = setup();
    const g = await guardReply(reply({ reply: "Google Maps: {MAP:cli_abcdefgh}", intent: "clinic" }), deps);
    expect(g).toMatchObject({ text: `Google Maps:\n\n${HELPLINE_CARD}`, droppedSyntax: ["{MAP:cli_abcdefgh}"] });
  });

  it("asks for a fresh find_clinics when a MAPS token names a retired facility", async () => {
    const { registry, deps, corrections } = setup();
    const c = registry.clinic("c1");
    const g = await guardReply(reply({ reply: `Google Maps: {{MAPS:${c}}}`, intent: "clinic" }), deps);
    expect(corrections).toEqual([{ correction: staleHandleNote([c]), purpose: "token" }]);
    expect(g).toMatchObject({ text: `Google Maps:\n\n${HELPLINE_CARD}`, staleHandles: [c] });
  });

  it("corrects a map link the model typed once, then strips it from the text and the template", async () => {
    const { registry, deps, corrections } = setup();
    const h = registry.clinic("h");
    const g = await guardReply(reply({ reply: `Call {{CLINIC:${h}}}. Google Maps: https://maps.google.com/?q=19.1,72.9`, intent: "clinic" }), deps);
    expect(corrections).toEqual([{ correction: LINK_CORRECTION_NOTE, purpose: "token" }]);
    expect(g).toMatchObject({ text: "Call +91 70000 00020. Google Maps:", template: `Call {{CLINIC:${h}}}. Google Maps:`, linksStripped: 1, scrubbed: false });
  });

  it("strips a goo.gl link and a map host typed without its scheme the same way", async () => {
    for (const typed of ["https://goo.gl/maps/AbCdEfGh", "maps.google.com/?q=19.1,72.9", "https://www.google.com/maps/search/Arham"]) {
      const { deps, corrections } = setup();
      const g = await guardReply(reply({ reply: `Location: ${typed} (tap to open).`, intent: "clinic" }), deps);
      expect(corrections, typed).toEqual([{ correction: LINK_CORRECTION_NOTE, purpose: "token" }]);
      expect(g, typed).toMatchObject({ text: "Location: (tap to open).", template: "Location: (tap to open).", linksStripped: 1 });
    }
  });

  it("lets a link on the website through, as a tool result gives it", async () => {
    const { deps, corrections } = setup();
    for (const page of ["https://alwayscare.org/hospitals/ghatkopar", "https://www.alwayscare.org/donate"]) {
      const g = await guardReply(reply({ reply: `Its page: ${page}.`, intent: "clinic" }), deps);
      expect(g, page).toMatchObject({ text: `Its page: ${page}.`, linksStripped: 0 });
    }
    expect(corrections).toEqual([]);
  });

  it("strips a typed map link beside the inserted one, never touching the inserted link, even when the typed one is its prefix", async () => {
    const { registry, deps } = setup();
    const h = registry.clinic("h");
    const typed = "https://maps.google.com/?q=19.0";
    const g = await guardReply(reply({ reply: `Google Maps: {{MAPS:${h}}} or ${typed}`, intent: "clinic" }), deps);
    expect(g).toMatchObject({ text: `Google Maps: ${GHATKOPAR_MAP} or`, template: `Google Maps: {{MAPS:${h}}} or`, linksStripped: 1 });
  });

  it("strips a typed link holding a phone number whole, with one correction naming both", async () => {
    const { deps, corrections } = setup();
    const g = await guardReply(reply({ reply: "Message them on https://wa.me/919876543210 now.", intent: "clinic" }), deps);
    expect(corrections).toEqual([{ correction: `${TOKEN_CORRECTION_NOTE} ${LINK_CORRECTION_NOTE}`, purpose: "token" }]);
    expect(g).toMatchObject({ text: "Message them on now.", template: "Message them on now.", linksStripped: 1, scrubbed: true });
  });

  it("sends the corrected draft when it no longer types the link", async () => {
    const { registry, deps } = setup();
    const h = registry.clinic("h");
    deps.retry = async () => reply({ reply: `Google Maps: {{MAPS:${h}}}`, intent: "clinic" });
    const g = await guardReply(reply({ reply: "Google Maps: https://maps.google.com/?q=19.1,72.9", intent: "clinic" }), deps);
    expect(g).toMatchObject({ text: `Google Maps: ${GHATKOPAR_MAP}`, template: `Google Maps: {{MAPS:${h}}}`, linksStripped: 0 });
  });

  it("returns an empty text when nothing survives and no number was inserted, for the caller to fall back", async () => {
    const { deps } = setup();
    const g = await guardReply(reply({ reply: "9876543210" }), deps);
    expect(g).toMatchObject({ text: "", template: "", scrubbed: true, restored: 0 });
  });
});
