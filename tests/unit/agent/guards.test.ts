import { describe, it, expect } from "vitest";
import { guardReply, STALE_HANDLE_NOTE, type GuardDeps } from "@/server/agent/guards";
import { HandleRegistry } from "@/server/agent/handles";
import type { StructuredReply } from "@/server/agent/types";
import type { DirectoryAmbulance, MatchType } from "@/server/directory/matcher";
import { buildHelplineCard } from "@/server/messages/cards";
import { DISPATCH_CORRECTION_NOTE, TOKEN_CORRECTION_NOTE } from "@/server/messages/system-replies";

const ghatkopar: DirectoryAmbulance = {
  id: "g", label: "Mumbai - Ghatkopar", city: "Mumbai", area: "Ghatkopar", state: "MH", areasCovered: [], category: "Animal Ambulance",
  phone: "+917000000001", operatorName: "Arham Yuva Seva Group", operatorIsArham: true,
};
const rajkot: DirectoryAmbulance = { ...ghatkopar, id: "r", label: "Rajkot - Blue Cross", city: "Rajkot", area: null, phone: "+919876500001", operatorName: "Blue Cross", operatorIsArham: false };
const units: Record<string, DirectoryAmbulance> = { g: ghatkopar, r: rajkot };
const CALL_DIRECTLY = "Please call them directly and they will guide you.";

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
    lookups: { ambulance: async (id) => (active.has(id) ? units[id] : undefined), clinic: async () => undefined },
    helplinePhone: "+919999900000",
    staticPhones: { volunteer: "+919888800000" },
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

  it("reports only handle-shaped drops, counts the ones holding digits, and keeps dropped syntax apart", async () => {
    const written = "Call {{AMB:amb_pppppppp}} or {{AMB:amb_zzzzzzzz}} or {AMB:x} or {{PHONE:98765}} now.";
    const { deps, corrections } = setup({ corrected: [reply({ reply: written })] });
    const g = await guardReply(reply({ reply: written }), deps);
    expect(corrections).toHaveLength(1);
    expect(g).toMatchObject({
      text: "Call or or or now.", template: "Call or or or now.", scrubbed: true, foreignRuns: 0, digitDrops: 1,
      unknownHandles: ["amb_pppppppp"], droppedSyntax: ["{AMB:x}"],
    });
  });

  it("asks for a fresh lookup when a shared unit was retired, and reports its handle as stale if it stays", async () => {
    const { registry, deps, corrections } = setup({ active: ["r"] });
    const h = registry.ambulance("g");
    const g = await guardReply(reply({ reply: `Number: {{AMB:${h}}}` }), deps);
    expect(corrections).toEqual([{ correction: `${TOKEN_CORRECTION_NOTE} ${STALE_HANDLE_NOTE}`, purpose: "token" }]);
    expect(g).toMatchObject({ text: "Number:", staleHandles: [h], unknownHandles: [], scrubbed: false, restored: 0 });
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

  it("returns an empty text when nothing survives and no number was inserted, for the caller to fall back", async () => {
    const { deps } = setup();
    const g = await guardReply(reply({ reply: "9876543210" }), deps);
    expect(g).toMatchObject({ text: "", template: "", scrubbed: true, restored: 0 });
  });
});
