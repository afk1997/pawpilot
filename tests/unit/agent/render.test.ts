import { describe, it, expect } from "vitest";
import { renderReply, cleanupFormatting, type RenderLookups } from "@/server/agent/render";
import { HandleRegistry, TOKEN_RE } from "@/server/agent/handles";
import type { DirectoryAmbulance } from "@/server/directory/matcher";
import type { DirectoryClinic } from "@/server/directory/repo";
import { buildAmbulanceCard } from "@/server/messages/cards";

const ghatkopar: DirectoryAmbulance = { id: "g", label: "Mumbai - Ghatkopar", city: "Mumbai", area: "Ghatkopar", state: "MH", areasCovered: [], category: "Animal Ambulance", phone: "+917000000001", operatorName: "Arham Yuva Seva Group", operatorIsArham: true };
const wadala: DirectoryAmbulance = { ...ghatkopar, id: "w", label: "Mumbai - Wadala", area: "Wadala", phone: "+917000000007", operatorName: "Hope for Indies Trust", operatorIsArham: false };
/** A clinic without a map link. */
const surat: DirectoryClinic = { id: "c", label: "Clinic", city: "Surat", area: null, state: "GJ", phone: "+912612345678", address: null, hours: null };
const GHATKOPAR_MAP = "https://maps.google.com/?q=19.07948,72.90119";
const hospital: DirectoryClinic = { ...surat, id: "h", label: "Mumbai - Ghatkopar Hospital", city: "Mumbai", area: "Ghatkopar", phone: "+917000000020", mapsUrl: GHATKOPAR_MAP };
/** A Maps value that is not one https link: never inserted. */
const notALink: DirectoryClinic = { ...surat, id: "x", mapsUrl: "near the station" };
/** Stored Maps values of any other shape than MAPS_URL_RE's, by id: none is ever inserted. */
const OTHER_SHAPES: Record<string, string> = {
  wa: "https://wa.me/919876543210",
  http: "http://maps.google.com/?q=19.07948,72.90119",
  query: "https://maps.google.com/?q=19.07948,72.90119&z=17",
  path: "https://maps.google.com/maps?q=19.07948,72.90119",
  seven: "https://maps.google.com/?q=19.0794812,72.9011934",
  search: "https://maps.google.com/?q=Arham+Ghatkopar",
  short: "https://goo.gl/maps/abcdefgh",
};
const otherShapes = Object.fromEntries(Object.entries(OTHER_SHAPES).map(([id, mapsUrl]) => [id, { ...surat, id, mapsUrl }]));
const lookups: RenderLookups = {
  ambulance: async (id) => ({ g: ghatkopar, w: wadala } as Record<string, DirectoryAmbulance>)[id],
  clinic: async (id) => ({ c: surat, h: hospital, x: notALink, ...otherShapes } as Record<string, DirectoryClinic>)[id],
};
const base = (registry: HandleRegistry, overrides: Partial<Parameters<typeof renderReply>[0]> = {}) => ({
  replyTemplate: "", lang: "en" as const, intent: "ambulance" as const, registry, lookups,
  helplinePhone: "+919999900000", staticPhones: { volunteer: "+919888800000" }, lastAmbulanceCandidates: null, lastAmbulanceMatch: "area" as const, ...overrides,
});

describe("renderReply", () => {
  it("accepts a handle written without its amb_/cli_ prefix (seen in the first real smoke run)", async () => {
    const r = new HandleRegistry("conv");
    const hg = r.ambulance("g"); const hc = r.clinic("c");
    const bareAmb = hg.slice("amb_".length); const bareCli = hc.slice("cli_".length);
    const out = await renderReply(base(r, { replyTemplate: `Number: {{AMB:${bareAmb}}} and clinic {{CLINIC:${bareCli.toUpperCase()}}}` }));
    expect(out.text).toBe("Number: +91 70000 00001 and clinic +91 26123 45678");
    expect(out.unknownHandles).toEqual([]);
    expect(out.appendedCard).toBe(false);
    expect(out.template).toContain(`{{AMB:${hg}}}`);
  });

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

  it("appends the card with the unit's hours line when it has published hours", async () => {
    const out = await renderReply(base(new HandleRegistry("conv"), {
      replyTemplate: "Please call the Ghatkopar ambulance.", lang: "hi", lastAmbulanceCandidates: [{ ...ghatkopar, hours: "10am–7pm IST" }],
    }));
    expect(out.text).toBe(
      "Please call the Ghatkopar ambulance.\n\nArham Animal Ambulance, Ghatkopar\n+91 70000 00001\nसमय: 10am–7pm IST (कॉल करके पुष्टि करें)\nकृपया उन्हें तुरंत कॉल करें।"
    );
    expect(out.inserted).toEqual(["+917000000001"]);
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

  it("gives a sent template that drops what the text drops and keeps a token for each number the text shows", async () => {
    const r = new HandleRegistry("conv");
    const hg = r.ambulance("g");
    const out = await renderReply(base(r, {
      replyTemplate: `**Call** {{amb: ${hg}}} or {{AMB:amb_zzzzzzzz}} or {{PHONE:98765}} or {{{PHONE:helpline}}} now`,
      lastAmbulanceCandidates: [wadala],
    }));
    expect(out.text).toBe("*Call* +91 70000 00001 or or or +91 99999 00000 now");
    expect(out.sentTemplate).toBe(`*Call* {{AMB:${hg}}} or or or {{PHONE:helpline}} now`);
    expect(out.template).toBe(`**Call** {{AMB:${hg}}} or {{AMB:amb_zzzzzzzz}} or {{PHONE:98765}} or {{{PHONE:helpline}}} now`);
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

describe("renderReply: map links", () => {
  it("substitutes a MAPS token with the facility's map link, keeps the token in the sent template and lists the link apart from the numbers", async () => {
    const r = new HandleRegistry("conv");
    const hh = r.clinic("h");
    const out = await renderReply(base(r, { replyTemplate: `Ghatkopar hospital: {{CLINIC:${hh}}}. Google Maps: {{MAPS:${hh}}}`, intent: "clinic" }));
    expect(out.text).toBe(`Ghatkopar hospital: +91 70000 00020. Google Maps: ${GHATKOPAR_MAP}`);
    expect(out.sentTemplate).toBe(`Ghatkopar hospital: {{CLINIC:${hh}}}. Google Maps: {{MAPS:${hh}}}`);
    expect(out.sentTemplate).not.toContain("maps.google.com");
    expect(out.inserted).toEqual(["+917000000020"]);
    expect(out.links).toEqual([GHATKOPAR_MAP]);
    expect(out.unknownHandles).toEqual([]);
    expect(out.appendedCard).toBe(false);
  });

  it.each([
    (h: string) => `{{maps:${h}}}`,
    (h: string) => `{{ Maps : ${h} }}`,
    (h: string) => `{{MAPS:\n${h.toUpperCase()}}}`,
    (h: string) => `{{MAPS:${h.slice("cli_".length)}}}`,
  ])("canonicalises map token form %#, a handle written without its cli_ prefix included", async (form) => {
    const r = new HandleRegistry("conv");
    const hh = r.clinic("h");
    const out = await renderReply(base(r, { replyTemplate: `Google Maps: ${form(hh)}`, intent: "clinic" }));
    expect(out.text).toBe(`Google Maps: ${GHATKOPAR_MAP}`);
    expect(out.template).toMatch(/^Google Maps: \{\{MAPS:cli_[a-p]{8}\}\}$/i);
    expect(out.links).toEqual([GHATKOPAR_MAP]);
    expect(out.unknownHandles).toEqual([]);
  });

  it("drops a MAPS token as an unknown handle's: a facility without a map link, a Maps value that is no link, a retired or unknown facility, an ambulance's handle", async () => {
    const r = new HandleRegistry("conv");
    const [hc, hx, gone, hg] = [r.clinic("c"), r.clinic("x"), r.clinic("gone"), r.ambulance("g")];
    const out = await renderReply(base(r, {
      replyTemplate: `A {{MAPS:${hc}}} B {{MAPS:${hx}}} C {{MAPS:${gone}}} D {{MAPS:cli_pppppppp}} E {{MAPS:${hg}}} F`, intent: "clinic",
    }));
    expect(out.text).toBe("A B C D E F");
    expect(out.sentTemplate).toBe("A B C D E F");
    expect(out.unknownHandles).toEqual([hc, hx, gone, "cli_pppppppp", hg]);
    expect(out.links).toEqual([]);
    expect(out.inserted).toEqual([]);
  });

  it.each(Object.keys(OTHER_SHAPES))("never inserts a stored Maps value of another shape (%s): the token goes", async (id) => {
    const r = new HandleRegistry("conv");
    const h = r.clinic(id);
    const out = await renderReply(base(r, { replyTemplate: `Google Maps: {{MAPS:${h}}}`, intent: "clinic" }));
    expect(out.text).toBe("Google Maps:");
    expect(out.links).toEqual([]);
    expect(out.unknownHandles).toEqual([h]);
  });

  it("keeps a map link whole or drops it whole at the cap", async () => {
    const r = new HandleRegistry("conv");
    const hh = r.clinic("h");
    const prefix = "a".repeat(4000 - GHATKOPAR_MAP.length - 1);
    const fits = await renderReply(base(r, { replyTemplate: `${prefix} {{MAPS:${hh}}}`, intent: "clinic" }));
    expect(fits.text).toBe(`${prefix} ${GHATKOPAR_MAP}`);
    expect(fits.links).toEqual([GHATKOPAR_MAP]);
    const over = await renderReply(base(r, { replyTemplate: `${prefix}a {{MAPS:${hh}}}`, intent: "clinic" }));
    expect(over.text).toBe(`${prefix}a`);
    expect(over.links).toEqual([]);
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
