import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { asc, eq } from "drizzle-orm";
import { resetDb, createConversation } from "../helpers/db";
import { seedDirectory, type DirectoryIds } from "../helpers/fixtures";
import { getDb } from "@/server/db/client";
import { events, messages, turns } from "@/server/db/schema";
import { storeReporterMessage } from "@/server/inbound/store";
import { runTurn } from "@/server/worker/turn-runner";
import { stopBoss } from "@/server/queue/boss";
import { FakeBackend, okReply } from "@/server/agent/fake-backend";
import { makeHandle } from "@/server/agent/handles";
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
const HEADER = "PRE-MATCHED UNITS (the system already looked up the reporter's words; use these handles directly — do not call find_ambulances again unless the reporter means a different place)";

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
    expect(backend.calls[0].prompt).toContain(`${HEADER}\n- {{AMB:${handle}}} — Arham Animal Ambulance, Ghatkopar (Mumbai) [match: area]\n`);
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
    expect((await outbound(c.id)).at(-1)!.content).toBe("Please call the Ghatkopar ambulance.\n\nArham Animal Ambulance, Ghatkopar\n+91 70000 00001\nPlease call them right away.");
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

  it("uses the place known so far when the reporter's words name none", async () => {
    const c = await conv();
    await storeReporterMessage(c.id, { kind: "text", content: "ghatkopar me kutta ghayal hai" });
    expect((await runTurn(c.id)).kind).toBe("fast_path");
    await storeReporterMessage(c.id, { kind: "text", content: "the driver is not answering" });
    const handle = makeHandle("ambulance", c.id, ids.ghatkopar);
    const backend = new FakeBackend([okReply({ reply: "Please call {{PHONE:helpline}}.", intent: "ambulance", needs_human: true })]);
    const r = await runTurn(c.id, { backend });
    expect(backend.calls[0].prompt).toContain(`${HEADER}\n- {{AMB:${handle}}} — Arham Animal Ambulance, Ghatkopar (Mumbai) [match: area]\n`);
    expect((await turnOf(r.turnId!)).toolCalls).toEqual([
      {
        name: "prematch", input: { city: "Mumbai", area: "Ghatkopar", query: "the driver is not answering" },
        output: { matchType: "area", count: 1, handles: [handle] }, durationMs: expect.any(Number),
      },
    ]);
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
