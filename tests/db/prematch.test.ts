import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { asc, eq } from "drizzle-orm";
import { resetDb, createConversation } from "../helpers/db";
import { seedDirectory, type DirectoryIds } from "../helpers/fixtures";
import { getDb } from "@/server/db/client";
import { ambulances, events, messages, turns } from "@/server/db/schema";
import { storeReporterMessage } from "@/server/inbound/store";
import { runTurn } from "@/server/worker/turn-runner";
import { stopBoss } from "@/server/queue/boss";
import { FakeBackend, okReply } from "@/server/agent/fake-backend";
import { makeHandle } from "@/server/agent/handles";
import { findDigitRuns } from "@/server/agent/scrub";
import type { ToolCallRecord } from "@/server/agent/tools";
import type { TurnInput } from "@/server/agent/types";
import { resetConfigForTests } from "@/server/config";
import * as repo from "@/server/directory/repo";
import { log } from "@/server/log";

let ids: DirectoryIds;
const conv = () => createConversation({ isTest: true, phone: `+91TEST_${Math.random().toString(36).slice(2, 9)}`, language: "en", welcomedAt: new Date() });
const outbound = async (id: string) =>
  (await getDb().select().from(messages).where(eq(messages.conversationId, id)).orderBy(asc(messages.createdAt))).filter((m) => m.role === "assistant");
const turnOf = async (id: string) => (await getDb().select().from(turns).where(eq(turns.id, id)))[0];
/** The Ghatkopar fixture unit's hours on its pre-matched line: the tool-boundary scrub writes every dash as "-". */
const GHATKOPAR_HOURS = ", hours 10am-7pm IST";
const HEADER = "PRE-MATCHED UNITS (the system already looked up the reporter's words; use these handles directly — do not call find_ambulances again unless the reporter means a different place)";
const knownHeader = (place: string) =>
  `PRE-MATCHED UNITS (the system looked up the location known so far (${place}), not the reporter's new words, which the code could not match to a place; use these handles only if the reporter still needs a unit there — for any other place call find_ambulances)`;

/** A conversation the model has already answered once, so its next burst goes to the model, not the fast path. */
async function answered() {
  const c = await conv();
  await storeReporterMessage(c.id, { kind: "text", content: "hello, I need help" });
  expect((await runTurn(c.id, { backend: new FakeBackend([okReply({ reply: "Where is the animal?", intent: "ambulance" })]) })).kind).toBe("ok");
  return c;
}

describe("pre-matched units", () => {
  beforeEach(async () => { await stopBoss(); await resetDb(); ids = await seedDirectory(); });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    resetConfigForTests();
    await stopBoss();
  });

  it("gives the model the handle of the one unit the reporter's words match, which it can use without a lookup", async () => {
    const c = await answered();
    await storeReporterMessage(c.id, { kind: "text", content: "ghatkopar" });
    const handle = makeHandle("ambulance", c.id, ids.ghatkopar);
    const backend = new FakeBackend([okReply({ reply: `Please call {{AMB:${handle}}} right away.`, intent: "ambulance", location: { city: "Mumbai", area: "Ghatkopar" } })]);
    const r = await runTurn(c.id, { backend });
    expect(r.kind).toBe("ok");
    expect(backend.calls[0].prompt).toContain(`${HEADER}\n- {{AMB:${handle}}} — Arham Animal Ambulance, Ghatkopar (Mumbai)${GHATKOPAR_HOURS} [match: area]\n`);
    expect((await outbound(c.id)).at(-1)!.content).toBe("Please call +91 70000 00001 right away.");
    const t = await turnOf(r.turnId!);
    expect(t.status).toBe("ok");
    expect(t.handles).toEqual({ [handle]: { kind: "ambulance", id: ids.ghatkopar } });
    const calls = t.toolCalls as ToolCallRecord[];
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ name: "prematch", input: { query: "ghatkopar" }, output: { matchType: "area", count: 1, handles: [handle] }, durationMs: expect.any(Number) });
  });

  it("sets the tool's state, so a reply that forgets the token still gets the unit's card", async () => {
    const c = await answered();
    await storeReporterMessage(c.id, { kind: "text", content: "ghatkopar" });
    const backend = new FakeBackend([okReply({ reply: "Please call the Ghatkopar ambulance.", intent: "ambulance" })]);
    expect((await runTurn(c.id, { backend })).kind).toBe("ok");
    expect((await outbound(c.id)).at(-1)!.content).toBe(
      "Please call the Ghatkopar ambulance.\n\nArham Animal Ambulance, Ghatkopar\n+91 70000 00001\nHours: 10am–7pm IST (call to confirm)\nPlease call them right away."
    );
  });

  it("lists two or three units of an exact match, partner operators named", async () => {
    const c = await answered();
    await storeReporterMessage(c.id, { kind: "text", content: "rajkot me gaay ghayal hai" });
    const backend = new FakeBackend([okReply({ reply: "Call either one.", intent: "other" })]);
    const r = await runTurn(c.id, { backend });
    const [a, b] = [makeHandle("ambulance", c.id, ids.rajkotA), makeHandle("ambulance", c.id, ids.rajkotB)];
    expect(backend.calls[0].prompt).toContain(
      `${HEADER}\n- {{AMB:${a}}} — Animal Ambulance, Rajkot (Rajkot), operated by Blue Cross [match: area]\n- {{AMB:${b}}} — Animal Ambulance, Rajkot (Rajkot), operated by Hope for Indies Trust [match: area]\n`
    );
    expect((await turnOf(r.turnId!)).toolCalls).toEqual([
      { name: "prematch", input: { query: "rajkot me gaay ghayal hai" }, output: { matchType: "area", count: 2, handles: [a, b] }, durationMs: expect.any(Number) },
    ]);
  });

  it.each([
    ["a loose (fuzzy) match", "Rajkott", "fuzzy", 2],
    ["more than three units", "Mumbai", "city", 6],
    ["no place at all", "the dog is bleeding", null, 0],
  ] as const)("adds nothing for %s and leaves the lookup to the model", async (_case, text, matchType, count) => {
    const c = await answered();
    await storeReporterMessage(c.id, { kind: "text", content: text });
    const backend = new FakeBackend([okReply({ reply: "Which area are you in?", intent: "ambulance" })]);
    const r = await runTurn(c.id, { backend });
    expect(backend.calls[0].prompt).not.toContain("PRE-MATCHED UNITS");
    // No state was set, so an ambulance reply without a token gets no card.
    expect((await outbound(c.id)).at(-1)!.content).toBe("Which area are you in?");
    const t = await turnOf(r.turnId!);
    expect(t.toolCalls).toEqual([{ name: "prematch", input: { query: text }, output: { matchType, count, handles: [] }, durationMs: expect.any(Number) }]);
    expect(t.handles).toEqual({});
  });

  it("offers the units of the place known so far when the words match none, without arming their card", async () => {
    const c = await conv();
    await storeReporterMessage(c.id, { kind: "text", content: "ghatkopar me kutta ghayal hai" });
    expect((await runTurn(c.id)).kind).toBe("fast_path");
    const query = "ek aur kutta Lonavala me ghayal hai";
    await storeReporterMessage(c.id, { kind: "text", content: query });
    const handle = makeHandle("ambulance", c.id, ids.ghatkopar);
    const reply = "Sorry, we don't cover Lonavala yet. Please contact a local animal rescue group there.";
    const backend = new FakeBackend([okReply({ reply, intent: "ambulance", needs_human: false, location: { city: "Lonavala", area: null } })]);
    const r = await runTurn(c.id, { backend });
    expect(r.kind).toBe("ok");
    const prompt = backend.calls[0].prompt;
    expect(prompt).toContain(`${knownHeader("Ghatkopar, Mumbai")}\n- {{AMB:${handle}}} — Arham Animal Ambulance, Ghatkopar (Mumbai)${GHATKOPAR_HOURS} [match: area]\n`);
    expect(prompt).not.toContain(HEADER);
    // An ambulance reply with no token, about another place: the earlier place's card is not appended.
    const sent = (await outbound(c.id)).at(-1)!;
    expect(sent.content).toBe(reply);
    expect(findDigitRuns(sent.content)).toEqual([]);
    expect(sent.content).not.toMatch(/\d/);
    expect((await turnOf(r.turnId!)).toolCalls).toEqual([
      { name: "prematch", input: { city: "Mumbai", area: "Ghatkopar", query }, output: { matchType: "area", count: 1, handles: [handle] }, durationMs: expect.any(Number) },
    ]);
  });

  it.each([
    // The Ahmedabad unit covers Ghuma, a word of this Hinglish sentence; Mumbai, which the reporter names, is another city.
    ["another covered city in the words", "Mumbai me gaadi ghuma rahe the, kutta ghayal ho gaya", "Mumbai mein kaunse area mein hain?", "other_city"],
    // Model Town is a Delhi unit's area and a common locality name in many cities; the reporter names no city.
    ["only a generic area name, the unit's city unnamed", "Model Town me kutta ghayal hai", "Aap kis city mein hain?", "generic_area"],
  ] as const)("pre-matches nothing for %s, so a reply asking for the place gets no wrong-city card", async (_case, text, reply, skipped) => {
    await getDb().insert(ambulances).values([
      { operatorId: ids.arhamOperatorId, label: "Ahmedabad", city: "Ahmedabad", area: null, state: "Gujarat", phone: "+919876500080", areasCovered: ["Satellite", "Ghuma"] },
      { operatorId: ids.arhamOperatorId, label: "Delhi - Old Delhi", city: "Delhi", area: "Old Delhi", state: "Delhi", phone: "+919876500081", areasCovered: ["Model Town", "Shalimar Bagh"] },
    ]);
    const c = await conv();
    await storeReporterMessage(c.id, { kind: "text", content: text });
    const backend = new FakeBackend([okReply({ reply, intent: "ambulance" })]);
    const r = await runTurn(c.id, { backend });
    // The fast path declined it first (the same rules), so the model answered.
    expect(r.kind).toBe("ok");
    expect(backend.calls[0].prompt).not.toContain("PRE-MATCHED");
    const sent = (await outbound(c.id)).at(-1)!;
    expect(sent.content).toBe(reply);
    expect(sent.content).not.toMatch(/\d/);
    const t = await turnOf(r.turnId!);
    expect(t.toolCalls).toEqual([
      { name: "prematch", input: { query: text }, output: { matchType: "area", count: 1, handles: [], skipped }, durationMs: expect.any(Number) },
    ]);
    expect(t.handles).toEqual({});
  });

  it("holds later words to the city an earlier model turn recorded: Ahmedabad's Ghuma is not pre-matched once Mumbai is known", async () => {
    await getDb().insert(ambulances).values(
      { operatorId: ids.arhamOperatorId, label: "Ahmedabad", city: "Ahmedabad", area: null, state: "Gujarat", phone: "+919876500080", areasCovered: ["Satellite", "Ghuma"] }
    );
    const c = await conv();
    await storeReporterMessage(c.id, { kind: "text", content: "Mumbai me kutta ghayal hai" });
    const ask = "Mumbai mein kaunsa area?";
    const backend = new FakeBackend([
      okReply({ reply: ask, intent: "ambulance", location: { city: "Mumbai", area: null } }),
      okReply({ reply: ask, intent: "ambulance", location: { city: "Mumbai", area: null } }),
    ]);
    expect((await runTurn(c.id, { backend })).kind).toBe("ok");
    const query = "gaadi ghuma rahe the tab dekha";
    await storeReporterMessage(c.id, { kind: "text", content: query });
    const r = await runTurn(c.id, { backend });
    expect(r.kind).toBe("ok");
    expect(backend.calls[1].prompt).toContain("Location known so far: Mumbai\n");
    expect(backend.calls[1].prompt).not.toContain("PRE-MATCHED");
    const sent = (await outbound(c.id)).at(-1)!;
    expect(sent.content).toBe(ask);
    expect(sent.content).not.toMatch(/\d/);
    const t = await turnOf(r.turnId!);
    expect(t.toolCalls).toEqual([
      { name: "prematch", input: { query }, output: { matchType: "area", count: 1, handles: [], skipped: "other_city" }, durationMs: expect.any(Number) },
    ]);
    expect(t.handles).toEqual({});
  });

  it("holds later words to the known city on a plain area name too: Surat's Vesu is not pre-matched once Mumbai is known", async () => {
    const c = await conv();
    await storeReporterMessage(c.id, { kind: "text", content: "Mumbai me kutta ghayal hai" });
    const ask = "Mumbai mein kaunsa area?";
    const backend = new FakeBackend([
      okReply({ reply: ask, intent: "ambulance", location: { city: "Mumbai", area: null } }),
      okReply({ reply: ask, intent: "ambulance", location: { city: "Mumbai", area: null } }),
    ]);
    expect((await runTurn(c.id, { backend })).kind).toBe("ok");
    const query = "Vesu me ek aur kutta";
    await storeReporterMessage(c.id, { kind: "text", content: query });
    const r = await runTurn(c.id, { backend });
    expect(r.kind).toBe("ok");
    expect(backend.calls[1].prompt).not.toContain("PRE-MATCHED");
    // What the reporter sees: the question as scripted, never Surat's card or number.
    const sent = (await outbound(c.id)).at(-1)!;
    expect(sent.content).toBe(ask);
    expect(sent.content).not.toContain("98765 00003");
    const t = await turnOf(r.turnId!);
    expect(t.toolCalls).toEqual([
      { name: "prematch", input: { query }, output: { matchType: "area", count: 1, handles: [], skipped: "other_city" }, durationMs: expect.any(Number) },
    ]);
    expect(t.handles).toEqual({});
  });

  it("pre-matches a generic area name in the city an earlier turn recorded (Karve Nagar once Pune is known)", async () => {
    const c = await conv();
    await storeReporterMessage(c.id, { kind: "text", content: "Pune me kutta ghayal hai" });
    const handle = makeHandle("ambulance", c.id, ids.puneA);
    const backend = new FakeBackend([
      okReply({ reply: "Pune mein kaunsa area?", intent: "ambulance", location: { city: "Pune", area: null } }),
      okReply({ reply: `Please call {{AMB:${handle}}} right away.`, intent: "ambulance", location: { city: "Pune", area: "Karve Nagar" } }),
    ]);
    expect((await runTurn(c.id, { backend })).kind).toBe("ok");
    await storeReporterMessage(c.id, { kind: "text", content: "Karve Nagar me" });
    expect((await runTurn(c.id, { backend })).kind).toBe("ok");
    expect(backend.calls[1].prompt).toContain(`${HEADER}\n- {{AMB:${handle}}} — Arham Animal Ambulance, PMC (Pune), covers Karve Nagar [match: area]\n`);
    expect((await outbound(c.id)).at(-1)!.content).toBe("Please call +91 98765 00005 right away.");
  });

  it("arms no card for a city name that is also an everyday word with no locative cue (the dog's face, not Surat)", async () => {
    const c = await answered();
    const query = "kutte ki surat pe chot hai";
    await storeReporterMessage(c.id, { kind: "text", content: query });
    const backend = new FakeBackend([okReply({ reply: "Aap kis city aur area mein hain?", intent: "ambulance" })]);
    const r = await runTurn(c.id, { backend });
    expect(backend.calls[0].prompt).not.toContain("PRE-MATCHED UNITS");
    // An ambulance reply asking for the place gets no Surat card.
    expect((await outbound(c.id)).at(-1)!.content).toBe("Aap kis city aur area mein hain?");
    expect((await turnOf(r.turnId!)).toolCalls).toEqual([
      { name: "prematch", input: { query }, output: { matchType: "area", count: 1, handles: [], skipped: "everyday_city" }, durationMs: expect.any(Number) },
    ]);
  });

  it("names the covered area an area match went through (Vikhroli, covered by the Ghatkopar unit)", async () => {
    const c = await answered();
    await storeReporterMessage(c.id, { kind: "text", content: "vikhroli station ke paas" });
    const handle = makeHandle("ambulance", c.id, ids.ghatkopar);
    const backend = new FakeBackend([okReply({ reply: `Please call {{AMB:${handle}}} right away.`, intent: "ambulance" })]);
    expect((await runTurn(c.id, { backend })).kind).toBe("ok");
    expect(backend.calls[0].prompt).toContain(`${HEADER}\n- {{AMB:${handle}}} — Arham Animal Ambulance, Ghatkopar (Mumbai), covers Vikhroli${GHATKOPAR_HOURS} [match: area]\n`);
  });

  it("uses the reporter's words, not the place known so far, when they name a place", async () => {
    const c = await conv();
    await storeReporterMessage(c.id, { kind: "text", content: "ghatkopar me kutta ghayal hai" });
    expect((await runTurn(c.id)).kind).toBe("fast_path");
    await storeReporterMessage(c.id, { kind: "text", content: "sorry, it is in surat" });
    const backend = new FakeBackend([okReply({ reply: "Noted.", intent: "ambulance" })]);
    const r = await runTurn(c.id, { backend });
    const surat = makeHandle("ambulance", c.id, ids.surat);
    expect(backend.calls[0].prompt).toContain(`${HEADER}\n- {{AMB:${surat}}} — Arham Animal Ambulance, Surat (Surat) [match: area]\n`);
    expect(((await turnOf(r.turnId!)).toolCalls as ToolCallRecord[])[0].input).toEqual({ query: "sorry, it is in surat" });
  });

  it("keeps the pre-match beside the model's own lookups in the audit, first", async () => {
    const c = await answered();
    await storeReporterMessage(c.id, { kind: "text", content: "ghatkopar" });
    const { findAmbulancesImpl } = await import("@/server/agent/tools");
    const backend = new FakeBackend([async (input: TurnInput) => {
      const out = await findAmbulancesImpl(input.toolContext!, { city: "Mumbai", area: "Ghatkopar", query: "ghatkopar" });
      return okReply({ reply: `Call {{AMB:${out.candidates[0].handle}}}.`, intent: "ambulance" });
    }]);
    const r = await runTurn(c.id, { backend });
    expect(((await turnOf(r.turnId!)).toolCalls as ToolCallRecord[]).map((call) => call.name)).toEqual(["prematch", "find_ambulances"]);
    expect((await outbound(c.id)).at(-1)!.content).toBe("Call +91 70000 00001.");
  });

  it("lets the model answer, visibly, when the pre-match lookup fails", async () => {
    vi.stubEnv("FAST_PATH_ENABLED", "false");
    resetConfigForTests();
    vi.spyOn(repo, "loadActiveAmbulances").mockRejectedValueOnce(Object.assign(new Error("pool exhausted for +919876543210"), { code: "53300" }));
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const c = await conv();
    await storeReporterMessage(c.id, { kind: "text", content: "ghatkopar" });
    const backend = new FakeBackend([okReply({ reply: "Please call {{PHONE:helpline}}.", intent: "ambulance" })]);
    const r = await runTurn(c.id, { backend });
    expect(r.kind).toBe("ok");
    expect(backend.calls[0].prompt).not.toContain("PRE-MATCHED UNITS");
    expect((await turnOf(r.turnId!)).toolCalls).toEqual([
      { name: "prematch", input: { query: "ghatkopar" }, output: null, durationMs: expect.any(Number), error: { errorClass: "Error", code: "53300" } },
    ]);
    const ev = await getDb().select().from(events).where(eq(events.kind, "prematch_error"));
    expect(ev.map((e) => e.payload)).toEqual([{ turnId: r.turnId, errorClass: "Error", code: "53300" }]);
    expect(warn).toHaveBeenCalledWith({ conversationId: c.id, errorClass: "Error", code: "53300" }, "prematch failed; the model looks the place up itself");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("9876543210");
  });
});
