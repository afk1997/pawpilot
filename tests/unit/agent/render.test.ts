import { describe, it, expect } from "vitest";
import { renderReply, cleanupFormatting, type RenderLookups } from "@/server/agent/render";
import { HandleRegistry, TOKEN_RE } from "@/server/agent/handles";
import type { DirectoryAmbulance } from "@/server/directory/matcher";
import { buildAmbulanceCard } from "@/server/messages/cards";

const ghatkopar: DirectoryAmbulance = { id: "g", label: "Mumbai - Ghatkopar", city: "Mumbai", area: "Ghatkopar", state: "MH", areasCovered: [], category: "Animal Ambulance", phone: "+917000000001", operatorName: "Arham Yuva Seva Group", operatorIsArham: true };
const wadala: DirectoryAmbulance = { ...ghatkopar, id: "w", label: "Mumbai - Wadala", area: "Wadala", phone: "+917000000007", operatorName: "Hope for Indies Trust", operatorIsArham: false };
const lookups: RenderLookups = {
  ambulance: async (id) => ({ g: ghatkopar, w: wadala } as Record<string, DirectoryAmbulance>)[id],
  clinic: async (id) => (id === "c" ? { id: "c", label: "Clinic", city: "Surat", area: null, state: "GJ", phone: "+912612345678", address: null, hours: null } : undefined),
};
const base = (registry: HandleRegistry, overrides: Partial<Parameters<typeof renderReply>[0]> = {}) => ({
  replyTemplate: "", lang: "en" as const, intent: "ambulance" as const, registry, lookups,
  helplinePhone: "+919999900000", staticPhones: { volunteer: "+919888800000" }, lastAmbulanceCandidates: null, lastAmbulanceMatch: "area" as const, ...overrides,
});

describe("renderReply", () => {
  it("substitutes ambulance, clinic, helpline and static phone tokens", async () => {
    const r = new HandleRegistry("conv");
    const hg = r.ambulance("g"); const hw = r.ambulance("w"); const hc = r.clinic("c");
    const out = await renderReply(base(r, { replyTemplate: `A {{AMB:${hg}}} B {{AMB:${hw}}} C {{CLINIC:${hc}}} D {{PHONE:helpline}} E {{PHONE:volunteer}}` }));
    expect(out.text).toBe("A +91 70000 00001 B +91 70000 00007 (operated by Hope for Indies Trust) C +91 26123 45678 D +91 99999 00000 E +91 98888 00000");
    expect(out.inserted.sort()).toEqual(["+912612345678", "+917000000001", "+917000000007", "+919888800000", "+919999900000"].sort());
    expect(out.template).toContain(`{{AMB:${hg}}}`);
  });

  it("drops unknown handles and reports them", async () => {
    const out = await renderReply(base(new HandleRegistry("conv"), { replyTemplate: "Call {{AMB:amb_00000000}} now" }));
    expect(out.text).toBe("Call now");
    expect(out.unknownHandles).toEqual(["amb_00000000"]);
  });

  it("appends a card when an ambulance reply forgot the token and one unit matched", async () => {
    const out = await renderReply(base(new HandleRegistry("conv"), { replyTemplate: "Please call the Ghatkopar ambulance.", lastAmbulanceCandidates: [ghatkopar] }));
    expect(out.appendedCard).toBe(true);
    expect(out.text).toContain("Arham Animal Ambulance, Ghatkopar\n+91 70000 00001");
    expect(out.inserted).toContain("+917000000001");
  });

  it("appends a multi card for two or three matches and nothing for more or other intents", async () => {
    const two = await renderReply(base(new HandleRegistry("conv"), { replyTemplate: "Two options.", lastAmbulanceCandidates: [ghatkopar, wadala] }));
    expect(two.text).toContain("2 ambulances are available in Mumbai");
    const many = await renderReply(base(new HandleRegistry("conv"), { replyTemplate: "Which area?", lastAmbulanceCandidates: [ghatkopar, wadala, ghatkopar, wadala] }));
    expect(many.appendedCard).toBe(false);
    const donate = await renderReply(base(new HandleRegistry("conv"), { replyTemplate: "Here is how to donate.", intent: "donate", lastAmbulanceCandidates: [ghatkopar] }));
    expect(donate.appendedCard).toBe(false);
  });

  it("cleans markdown WhatsApp can't render", () => {
    expect(cleanupFormatting("# Title\n**bold** text\n- item one\n\n\n\nend")).toBe("Title\n*bold* text\n• item one\n\nend");
  });
});

describe("renderReply guards", () => {
  it("appends no card when the last match was fuzzy, since the model is confirming the place", async () => {
    const out = await renderReply(base(new HandleRegistry("conv"), { replyTemplate: "Did you mean Ghatkopar?", lastAmbulanceCandidates: [ghatkopar], lastAmbulanceMatch: "fuzzy" }));
    expect(out.appendedCard).toBe(false);
    expect(out.text).toBe("Did you mean Ghatkopar?");
    expect(out.inserted).toEqual([]);
  });

  it("appends a card after a city match but not after any other loose match", async () => {
    const city = await renderReply(base(new HandleRegistry("conv"), { replyTemplate: "Please call the Mumbai ambulance.", lastAmbulanceCandidates: [ghatkopar], lastAmbulanceMatch: "city" }));
    expect(city.appendedCard).toBe(true);
    for (const match of ["substring", "token", "neighbour", null] as const) {
      const out = await renderReply(base(new HandleRegistry("conv"), { replyTemplate: "Which area exactly?", lastAmbulanceCandidates: [ghatkopar], lastAmbulanceMatch: match }));
      expect(out.appendedCard).toBe(false);
    }
  });

  it("renders every token even after a caller has used the shared TOKEN_RE", async () => {
    const r = new HandleRegistry("conv");
    const hg = r.ambulance("g");
    expect(TOKEN_RE.test(`{{AMB:${hg}}}`)).toBe(true);
    expect(TOKEN_RE.lastIndex).toBeGreaterThan(0);
    try {
      const out = await renderReply(base(r, { replyTemplate: `D {{PHONE:helpline}} A {{AMB:${hg}}}` }));
      expect(out.text).toBe("D +91 99999 00000 A +91 70000 00001");
    } finally {
      TOKEN_RE.lastIndex = 0;
    }
  });

  it("keeps the card fallback when the AMB token did not resolve to a unit", async () => {
    const r = new HandleRegistry("conv");
    const deactivated = r.ambulance("gone");
    const clinicHandle = r.clinic("c");
    for (const handle of ["amb_zzzzzzzz", deactivated, clinicHandle]) {
      const out = await renderReply(base(r, { replyTemplate: `Please call {{AMB:${handle}}} now.`, lastAmbulanceCandidates: [ghatkopar] }));
      expect(out.unknownHandles).toEqual([handle]);
      expect(out.appendedCard).toBe(true);
      expect(out.text).toBe("Please call now.\n\nArham Animal Ambulance, Ghatkopar\n+91 70000 00001\nPlease call them right away.");
      expect(out.inserted).toEqual(["+917000000001"]);
    }
  });

  it("treats inherited object keys as unknown PHONE keys", async () => {
    const out = await renderReply(base(new HandleRegistry("conv"), { replyTemplate: "Call {{PHONE:constructor}} or {{PHONE:__proto__}} or {{PHONE:toString}} now." }));
    expect(out.text).toBe("Call or or now.");
    expect(out.unknownHandles).toEqual(["constructor", "__proto__", "toString"]);
    expect(out.inserted).toEqual([]);
  });

  it("drops leftover template syntax and reports it under its raw text", async () => {
    const nested = await renderReply(base(new HandleRegistry("conv"), { replyTemplate: "Call {{{AMB:x}}} now" }));
    expect(nested.text).toBe("Call now");
    expect(nested.unknownHandles).toEqual(["x", "{", "}"]);
    const broken = await renderReply(base(new HandleRegistry("conv"), { replyTemplate: "Call {{AMB: amb_x}} or {{amb:amb_x}} or {AMB:amb_x} now {{" }));
    expect(broken.text).toBe("Call or or now");
    // The first two are recoverable spellings of one token, whose handle is unknown; the rest are leftover syntax.
    expect(broken.unknownHandles).toEqual(["amb_x", "{AMB:amb_x}", "{{"]);
  });

  it("keeps the inserted number when a token is wrapped in extra braces", async () => {
    const r = new HandleRegistry("conv");
    const hg = r.ambulance("g");
    const out = await renderReply(base(r, { replyTemplate: `Call {{{AMB:${hg}}}} or {{{{PHONE:helpline}}}} now` }));
    expect(out.text).toBe("Call +91 70000 00001 or +91 99999 00000 now");
    expect(out.inserted).toEqual(["+917000000001", "+919999900000"]);
  });
});

describe("renderReply: loosely written tokens", () => {
  it.each([
    ["{{ PHONE: helpline }}", "+91 99999 00000"],
    ["{{phone:helpline}}", "+91 99999 00000"],
    ["{{PHONE:Helpline}}", "+91 99999 00000"],
    ["{{ Phone :VOLUNTEER }}", "+91 98888 00000"],
  ])("canonicalises %j and resolves the PHONE key in any case", async (token, number) => {
    const out = await renderReply(base(new HandleRegistry("conv"), { replyTemplate: `Call ${token} now.`, intent: "other" }));
    expect(out.text).toBe(`Call ${number} now.`);
    expect(out.unknownHandles).toEqual([]);
  });

  it.each([
    (h: string) => `{{amb:${h}}}`,
    (h: string) => `{{AMB:\n${h}}}`,
    (h: string) => `{{ AMB : ${h} }}`,
    (h: string) => `{{Amb:${h.toUpperCase()}}}`,
  ])("canonicalises ambulance token form %#", async (form) => {
    const r = new HandleRegistry("conv");
    const hg = r.ambulance("g");
    const out = await renderReply(base(r, { replyTemplate: `Call ${form(hg)} now.` }));
    expect(out.text).toBe("Call +91 70000 00001 now.");
    expect(out.unknownHandles).toEqual([]);
    expect(out.appendedCard).toBe(false);
    expect(out.template).toMatch(/^Call \{\{AMB:[a-zA-Z_]+\}\} now\.$/);
  });

  it("canonicalises a clinic token", async () => {
    const r = new HandleRegistry("conv");
    const hc = r.clinic("c");
    const out = await renderReply(base(r, { replyTemplate: `Clinic: {{ clinic:${hc} }}`, intent: "clinic" }));
    expect(out.text).toBe("Clinic: +91 26123 45678");
    expect(out.template).toBe(`Clinic: {{CLINIC:${hc}}}`);
  });

  it("replaces every position of a repeated token and inserts its number once", async () => {
    const r = new HandleRegistry("conv");
    const hg = r.ambulance("g");
    const out = await renderReply(base(r, { replyTemplate: `A {{AMB:${hg}}} B {{AMB:${hg}}} C {{amb:${hg.toUpperCase()}}}` }));
    expect(out.text).toBe("A +91 70000 00001 B +91 70000 00001 C +91 70000 00001");
    expect(out.inserted).toEqual(["+917000000001"]);
  });

  it("drops a CLINIC token that holds an ambulance handle", async () => {
    const r = new HandleRegistry("conv");
    const hg = r.ambulance("g");
    const out = await renderReply(base(r, { replyTemplate: `Clinic {{CLINIC:${hg}}} now.`, intent: "clinic" }));
    expect(out.text).toBe("Clinic now.");
    expect(out.unknownHandles).toEqual([hg]);
    expect(out.inserted).toEqual([]);
  });

  it("renders a Hindi partner suffix", async () => {
    const r = new HandleRegistry("conv");
    const hw = r.ambulance("w");
    const out = await renderReply(base(r, { replyTemplate: `नंबर: {{AMB:${hw}}}`, lang: "hi" }));
    expect(out.text).toBe("नंबर: +91 70000 00007 (Hope for Indies Trust द्वारा संचालित)");
    expect(out.inserted).toEqual(["+917000000007"]);
  });
});

describe("renderReply: length cap", () => {
  const card = buildAmbulanceCard(ghatkopar, "en");

  it("cuts a long reply to leave room for the whole card", async () => {
    const out = await renderReply(base(new HandleRegistry("conv"), { replyTemplate: "a".repeat(3990), lastAmbulanceCandidates: [ghatkopar] }));
    expect(out.appendedCard).toBe(true);
    expect(out.text).toBe(`${"a".repeat(4000 - card.length - 2)}\n\n${card}`);
    expect(out.text).toHaveLength(4000);
    expect(out.inserted).toEqual(["+917000000001"]);
  });

  it("cuts before a number the cap would split, never inside it", async () => {
    const room = 4000 - card.length - 2;
    const prefix = "a".repeat(room - 5);
    const withCard = await renderReply(base(new HandleRegistry("conv"), { replyTemplate: `${prefix} {{PHONE:helpline}} more`, lastAmbulanceCandidates: [ghatkopar] }));
    expect(withCard.text).toBe(`${prefix}\n\n${card}`);
    expect(withCard.inserted).toEqual(["+917000000001"]);

    const r = new HandleRegistry("conv");
    const hw = r.ambulance("w");
    const long = "b".repeat(3980);
    // A partner unit's number carries its label; the label is part of the number and is never cut either.
    const alone = await renderReply(base(r, { replyTemplate: `${long} {{AMB:${hw}}} tail`, intent: "other" }));
    expect(alone.text).toBe(long);
    expect(alone.inserted).toEqual([]);
  });

  it("caps a reply without a card at 4000 characters and never splits an emoji", async () => {
    const out = await renderReply(base(new HandleRegistry("conv"), { replyTemplate: `${"a".repeat(3999)}\uD83D\uDE4F more`, intent: "other" }));
    expect(out.text).toBe("a".repeat(3999));
  });

  it("keeps a number whole when it fits exactly", async () => {
    const prefix = "a".repeat(4000 - "+91 99999 00000".length - 1);
    const out = await renderReply(base(new HandleRegistry("conv"), { replyTemplate: `${prefix} {{PHONE:helpline}} more`, intent: "other" }));
    expect(out.text).toBe(`${prefix} +91 99999 00000`);
    expect(out.inserted).toEqual(["+919999900000"]);
  });
});
