import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { asc, eq } from "drizzle-orm";
import { resetDb, createConversation } from "../helpers/db";
import { seedDirectory, type DirectoryIds } from "../helpers/fixtures";
import { getDb } from "@/server/db/client";
import { ambulances, conversations, events, messages, turns } from "@/server/db/schema";
import { storeReporterMessage } from "@/server/inbound/store";
import { runTurn } from "@/server/worker/turn-runner";
import { stopBoss } from "@/server/queue/boss";
import { FakeBackend, okReply, errorResult } from "@/server/agent/fake-backend";
import { findAmbulancesImpl } from "@/server/agent/tools";
import { makeHandle } from "@/server/agent/handles";
import { createTurn, finishTurn } from "@/server/worker/persist";
import { getWorkerState, isClaudePaused, pauseClaude } from "@/server/worker/pause";
import type { LLMBackend, ObservedToolUse, TurnInput, TurnResult } from "@/server/agent/types";
import * as agent from "@/server/agent";
import * as render from "@/server/agent/render";
import { formatIst } from "@/server/agent/prompt";
import { findDigitRuns } from "@/server/agent/scrub";
import { setFetchForTests } from "@/server/interakt/client";
import { log } from "@/server/log";
import { buildHelplineCard } from "@/server/messages/cards";
import { DISPATCH_CORRECTION_NOTE, TOKEN_CORRECTION_NOTE, staleHandleNote } from "@/server/messages/system-replies";

let ids: DirectoryIds;
async function conv(language: "en" | "hi" | "mr" | "gu" | null = "en") {
  const c = await createConversation({ isTest: true, phone: `+91TEST_${Math.random().toString(36).slice(2, 9)}`, language, welcomedAt: new Date() });
  return c;
}
const outbound = async (id: string) =>
  (await getDb().select().from(messages).where(eq(messages.conversationId, id)).orderBy(asc(messages.createdAt))).filter((m) => m.role === "assistant");
const lastTurn = async (id: string) => (await getDb().select().from(turns).where(eq(turns.conversationId, id)).orderBy(asc(turns.createdAt))).pop()!;

/** A scripted step that behaves like Claude: looks up Ghatkopar via the tool and answers with the token. */
const ghatkoparStep = async (input: TurnInput) => {
  const out = await findAmbulancesImpl(input.toolContext!, { city: "Mumbai", area: "Ghatkopar", query: "ghatkopar" });
  return okReply({ reply: `Yeh raha number: {{AMB:${out.candidates[0].handle}}}. Please turant call kijiye.`, language: "hi", intent: "ambulance", location: { city: "Mumbai", area: "Ghatkopar" } });
};

describe("runTurn with a backend", () => {
  beforeEach(async () => { await stopBoss(); await resetDb(); ids = await seedDirectory(); });
  afterEach(async () => { await stopBoss(); });

  it("renders the token, persists the template and records the turn", async () => {
    const c = await conv();
    await storeReporterMessage(c.id, { kind: "text", content: "ghatkopar me kutta ghayal hai" });
    const backend = new FakeBackend([ghatkoparStep]);
    const r = await runTurn(c.id, { backend });
    expect(r.kind).toBe("ok");
    const [m] = await outbound(c.id);
    expect(m.content).toBe("Yeh raha number: +91 70000 00001. Please turant call kijiye.");
    expect(m.contentTemplate).toMatch(/\{\{AMB:amb_[a-p]{8}\}\}/);
    expect(m.turnId).toBe(r.turnId);
    const t = await lastTurn(c.id);
    expect(t.status).toBe("ok");
    expect((t.toolCalls as { name: string }[])[0].name).toBe("find_ambulances");
    expect(Object.keys(t.handles as object)).toHaveLength(1);
    const [row] = await getDb().select().from(conversations).where(eq(conversations.id, c.id));
    expect(row.language).toBe("hi");
    expect((await getWorkerState()).lastOkTurnAt).not.toBeNull();
    expect(backend.calls[0].prompt).toContain("NEW MESSAGES");
    expect(backend.calls[0].systemPrompt).toContain("- Mumbai:");
  });

  it("resolves a handle issued in an earlier turn", async () => {
    const c = await conv();
    const h = makeHandle("ambulance", c.id, ids.ghatkopar);
    const old = await createTurn({ conversationId: c.id, status: "ok" });
    await finishTurn(old.id, { handles: { [h]: { kind: "ambulance", id: ids.ghatkopar } } });
    await storeReporterMessage(c.id, { kind: "text", content: "number phir se bhejo" });
    await runTurn(c.id, { backend: new FakeBackend([okReply({ reply: `Number: {{AMB:${h}}}`, intent: "ambulance" })]) });
    const [m] = await outbound(c.id);
    expect(m.content).toBe("Number: +91 70000 00001");
  });

  it("strips digits the model typed after one correction attempt", async () => {
    const c = await conv();
    await storeReporterMessage(c.id, { kind: "text", content: "surat" });
    const backend = new FakeBackend([okReply({ reply: "Call 9876543210 now.", intent: "other" }), okReply({ reply: "Call 9876543210 now.", intent: "other" })]);
    await runTurn(c.id, { backend });
    expect(backend.calls).toHaveLength(2);
    expect(backend.calls[1].prompt).toContain("SYSTEM CORRECTION");
    const [m] = await outbound(c.id);
    expect(m.content).toBe("Call now.");
    expect((await lastTurn(c.id)).scrubbed).toBe(true);
    const ev = await getDb().select().from(events).where(eq(events.kind, "scrub_strip"));
    expect(ev).toHaveLength(1);
  });

  it("accepts a corrected reply on the second attempt", async () => {
    const c = await conv();
    await storeReporterMessage(c.id, { kind: "text", content: "surat" });
    const backend = new FakeBackend([okReply({ reply: "Call 9876543210 now.", intent: "other" }), okReply({ reply: "Please call our helpline {{PHONE:helpline}}.", intent: "other" })]);
    await runTurn(c.id, { backend });
    const [m] = await outbound(c.id);
    expect(m.content).toBe("Please call our helpline +91 99999 00000.");
    expect((await lastTurn(c.id)).scrubbed).toBe(false);
  });

  it("replaces dispatch language", async () => {
    const c = await conv();
    await storeReporterMessage(c.id, { kind: "text", content: "surat" });
    const backend = new FakeBackend([okReply({ reply: "We are sending the ambulance now. Stay calm.", intent: "ambulance" }), okReply({ reply: "We are sending the ambulance now. Stay calm.", intent: "ambulance" })]);
    await runTurn(c.id, { backend });
    const [m] = await outbound(c.id);
    expect(m.content).toBe("Please call them directly and they will guide you. Stay calm.");
  });

  it("appends a card when the model forgot the token and one unit matched", async () => {
    const c = await conv();
    await storeReporterMessage(c.id, { kind: "text", content: "ghatkopar" });
    const backend = new FakeBackend([async (input: TurnInput) => {
      await findAmbulancesImpl(input.toolContext!, { city: "Mumbai", area: "Ghatkopar", query: "ghatkopar" });
      return okReply({ reply: "Please call the Ghatkopar ambulance.", intent: "ambulance" });
    }]);
    await runTurn(c.id, { backend });
    const [m] = await outbound(c.id);
    expect(m.content).toContain("Arham Animal Ambulance, Ghatkopar\n+91 70000 00001");
  });

  it("pauses Claude and falls back on LIMITED, then skips the backend while paused", async () => {
    const c = await conv();
    await storeReporterMessage(c.id, { kind: "text", content: "surat" });
    const backend = new FakeBackend([errorResult("LIMITED", "limit", new Date(Date.now() + 60_000)), ghatkoparStep]);
    const r = await runTurn(c.id, { backend });
    expect(r.kind).toBe("fallback");
    expect(await isClaudePaused()).toBe(true);
    const [m] = await outbound(c.id);
    expect(m.content).toContain("Arham Animal Ambulance, Surat");
    await storeReporterMessage(c.id, { kind: "text", content: "rajkot" });
    await runTurn(c.id, { backend });
    expect(backend.calls).toHaveLength(1);
    const out = await outbound(c.id);
    expect(out[1].content).toContain("2 ambulances are available in Rajkot");
  });

  it("records an auth event and falls back on AUTH", async () => {
    const c = await conv();
    await storeReporterMessage(c.id, { kind: "text", content: "surat" });
    await runTurn(c.id, { backend: new FakeBackend([errorResult("AUTH", "not logged in")]) });
    expect((await getDb().select().from(events).where(eq(events.kind, "claude_auth_error"))).length).toBe(1);
    expect((await lastTurn(c.id)).status).toBe("fallback");
  });

  it("retries once on INVALID_OUTPUT and TRANSIENT, then falls back", async () => {
    const c = await conv();
    await storeReporterMessage(c.id, { kind: "text", content: "surat" });
    const backend = new FakeBackend([errorResult("INVALID_OUTPUT"), errorResult("TRANSIENT"), errorResult("TRANSIENT")]);
    const r = await runTurn(c.id, { backend });
    expect(r.kind).toBe("fallback");
    expect(backend.calls).toHaveLength(2);
    const c2 = await conv();
    await storeReporterMessage(c2.id, { kind: "text", content: "hello again" });
    const b2 = new FakeBackend([errorResult("TRANSIENT"), okReply({ reply: "Namaste! Kaise madad karun?", language: "hi", intent: "smalltalk" })]);
    expect((await runTurn(c2.id, { backend: b2 })).kind).toBe("ok");
  });

  it("flags the conversation when the model asks for a human", async () => {
    const c = await conv();
    await storeReporterMessage(c.id, { kind: "text", content: "I want to talk to a person" });
    await runTurn(c.id, { backend: new FakeBackend([okReply({ reply: "Sure, call {{PHONE:helpline}}.", intent: "other", needs_human: true, notes: "asked for human" })]) });
    const [row] = await getDb().select().from(conversations).where(eq(conversations.id, c.id));
    expect(row.flagged).toBe(true);
    expect(row.flagReason).toBe("needs_human");
    expect((await lastTurn(c.id)).structuredOutput).toMatchObject({ notes: "asked for human" });
  });
});

const eventsOf = async (kind: string) => getDb().select().from(events).where(eq(events.kind, kind)).orderBy(asc(events.createdAt));
const turnsOf = async (id: string) => getDb().select().from(turns).where(eq(turns.conversationId, id)).orderBy(asc(turns.createdAt));
const conversationRow = async (id: string) => (await getDb().select().from(conversations).where(eq(conversations.id, id)))[0];
const withToolUses = (r: TurnResult, toolUses: ObservedToolUse[], extra: { extraUsage?: boolean } = {}): TurnResult => ({ ...r, toolUses, ...extra }) as TurnResult;

describe("the Claude turn's guards, audit and context", () => {
  beforeEach(async () => { await stopBoss(); await resetDb(); ids = await seedDirectory(); });
  afterEach(async () => {
    await stopBoss();
    setFetchForTests(null);
    vi.restoreAllMocks();
  });

  it("folds native numerals before the digit guard, so a Devanagari number is caught and kept out of the template", async () => {
    const c = await conv("hi");
    await storeReporterMessage(c.id, { kind: "text", content: "सूरत" });
    const backend = new FakeBackend([okReply({ reply: "कॉल करें ९८७६५४३२१० अभी।", language: "hi" })]);
    await runTurn(c.id, { backend });
    expect(backend.calls).toHaveLength(2);
    expect(backend.calls[1].prompt).toContain(TOKEN_CORRECTION_NOTE);
    const [m] = await outbound(c.id);
    expect([m.content, m.contentTemplate]).toEqual(["कॉल करें अभी।", "कॉल करें अभी।"]);
    expect((await lastTurn(c.id)).scrubbed).toBe(true);
  });

  it("stores the template without the stripped digits, so the next transcript never shows them", async () => {
    const c = await conv();
    await storeReporterMessage(c.id, { kind: "text", content: "surat" });
    await runTurn(c.id, { backend: new FakeBackend([okReply({ reply: "Call 98765 43210 or {{PHONE:helpline}} now." })]) });
    const [m] = await outbound(c.id);
    expect(m.content).toBe("Call or +91 99999 00000 now.");
    expect(m.contentTemplate).toBe("Call or {{PHONE:helpline}} now.");
    const [ev] = await eventsOf("scrub_strip");
    expect(ev.payload).toEqual({ turnId: m.turnId, runs: 1, drops: 0 });
  });

  it("allows a number this turn's tool output carries, but not one retyped from an earlier reply", async () => {
    const c = await conv();
    // An earlier fallback card: a template-less row, which the transcript shows masked.
    await getDb().insert(messages).values({
      conversationId: c.id, role: "assistant", origin: "fallback", content: "Arham Animal Ambulance, Surat\n+91 98765 00003", deliveryStatus: "test_skipped",
    });
    await storeReporterMessage(c.id, { kind: "text", content: "how many animals have you helped? and the number again" });
    const backend = new FakeBackend([async (input: TurnInput) => {
      input.toolContext!.calls.push({ name: "get_info", input: { topic: "about" }, output: { rescues: 12345678 }, durationMs: 1 });
      return okReply({ reply: "We have helped 12345678 animals. Call 9876500003.", intent: "faq" });
    }]);
    await runTurn(c.id, { backend });
    expect(backend.calls).toHaveLength(2);
    expect(backend.calls[0].prompt).not.toContain("9876500003");
    const m = (await outbound(c.id)).at(-1)!;
    expect(m.content).toBe("We have helped 12345678 animals. Call.");
    expect((await lastTurn(c.id)).scrubbed).toBe(true);
  });

  it("treats a dropped token that holds digits as typed digits: one corrective retry", async () => {
    const c = await conv();
    await storeReporterMessage(c.id, { kind: "text", content: "helpline number?" });
    const backend = new FakeBackend([okReply({ reply: "Call {{PHONE:9876543210}} now." }), okReply({ reply: "Call {{PHONE:helpline}} now." })]);
    await runTurn(c.id, { backend });
    expect(backend.calls).toHaveLength(2);
    expect(backend.calls[1].prompt).toContain(TOKEN_CORRECTION_NOTE);
    const [m] = await outbound(c.id);
    expect(m.content).toBe("Call +91 99999 00000 now.");
    expect((await lastTurn(c.id)).scrubbed).toBe(false);
    expect(await eventsOf("scrub_strip")).toHaveLength(0);
  });

  it("marks the reply scrubbed when the retry repeats a number inside token syntax, keeping its digits out of the template", async () => {
    const c = await conv();
    await storeReporterMessage(c.id, { kind: "text", content: "helpline number?" });
    const backend = new FakeBackend([okReply({ reply: "Call {{AMB:98765 43210}} or {{PHONE:9876543210}} now." })]);
    await runTurn(c.id, { backend });
    expect(backend.calls).toHaveLength(2);
    const [m] = await outbound(c.id);
    // The AMB token the model wrote a number into was dropped and no number was left: the helpline card follows.
    const card = buildHelplineCard("+919999900000", "en");
    expect(m.content).toBe(`Call or now.\n\n${card}`);
    expect(m.contentTemplate).toBe(`Call or now.\n\n${card.replace("+91 99999 00000", "{{PHONE:helpline}}")}`);
    expect(findDigitRuns(m.contentTemplate!)).toEqual([]);
    const t = await lastTurn(c.id);
    expect(t.scrubbed).toBe(true);
    const [ev] = await eventsOf("scrub_strip");
    expect(ev.payload).toEqual({ turnId: t.id, runs: 0, drops: 2 });
  });

  it("records only handle-shaped drops as unknown_handle events and keeps dropped syntax on the turn", async () => {
    const c = await conv();
    await storeReporterMessage(c.id, { kind: "text", content: "number?" });
    // amb_pppppppp has a handle's shape; amb_zzzzzzzz does not (handles use the letters a to p only).
    const backend = new FakeBackend([okReply({ reply: "Call {{AMB:amb_pppppppp}} or {{AMB:amb_zzzzzzzz}} or {AMB:x} now.", notes: "n" })]);
    await runTurn(c.id, { backend });
    expect(backend.calls).toHaveLength(1);
    const [m] = await outbound(c.id);
    // Every token dropped and no number left: the helpline card follows.
    const card = buildHelplineCard("+919999900000", "en");
    expect(m.content).toBe(`Call or or now.\n\n${card}`);
    expect(m.contentTemplate).toBe(`Call or or now.\n\n${card.replace("+91 99999 00000", "{{PHONE:helpline}}")}`);
    const t = await lastTurn(c.id);
    expect((await eventsOf("unknown_handle")).map((e) => e.payload)).toEqual([{ turnId: t.id, handles: ["amb_pppppppp"] }]);
    expect(t.structuredOutput).toMatchObject({ notes: "n", droppedSyntax: ["{AMB:x}"] });
    expect(t.scrubbed).toBe(false);
  });

  it("keeps the number, its partner label and its token when the dispatch sentence holding them is replaced", async () => {
    const c = await conv();
    const h = makeHandle("ambulance", c.id, ids.rajkotA);
    const old = await createTurn({ conversationId: c.id, status: "ok" });
    await finishTurn(old.id, { handles: { [h]: { kind: "ambulance", id: ids.rajkotA } } });
    await storeReporterMessage(c.id, { kind: "text", content: "rajkot" });
    const backend = new FakeBackend([okReply({ reply: `We are sending {{AMB:${h}}} to you now. Stay calm.`, intent: "ambulance" })]);
    await runTurn(c.id, { backend });
    expect(backend.calls).toHaveLength(2);
    expect(backend.calls[1].prompt).toContain(DISPATCH_CORRECTION_NOTE);
    const [m] = await outbound(c.id);
    expect(m.content).toBe("Please call them directly and they will guide you. +91 98765 00001 (operated by Blue Cross) Stay calm.");
    expect(m.contentTemplate).toBe(`Please call them directly and they will guide you. {{AMB:${h}}} Stay calm.`);
    expect((await eventsOf("dispatch_language_strip")).map((e) => e.payload)).toEqual([{ turnId: m.turnId }]);
    expect(await eventsOf("number_restored")).toHaveLength(0);
  });

  it("stores the template with the dispatch sentence replaced, so the next transcript never shows it", async () => {
    const c = await conv("hi");
    await storeReporterMessage(c.id, { kind: "text", content: "सूरत" });
    const reply = "हम एम्बुलेंस भेज रहे हैं। कृपया {{PHONE:helpline}} पर कॉल करें।";
    await runTurn(c.id, { backend: new FakeBackend([okReply({ reply, language: "hi", intent: "ambulance" })]) });
    const [m] = await outbound(c.id);
    expect(m.content).toBe("कृपया उन्हें सीधे कॉल करें, वे आपका मार्गदर्शन करेंगे। कृपया +91 99999 00000 पर कॉल करें।");
    expect(m.contentTemplate).toBe("कृपया उन्हें सीधे कॉल करें, वे आपका मार्गदर्शन करेंगे। कृपया {{PHONE:helpline}} पर कॉल करें।");
  });

  it("runs the digit guard on the dispatch retry's reply too", async () => {
    const c = await conv();
    await storeReporterMessage(c.id, { kind: "text", content: "surat" });
    const backend = new FakeBackend([
      okReply({ reply: "The ambulance is on its way. Call {{PHONE:helpline}}." }),
      okReply({ reply: "Call 9876543210 or {{PHONE:helpline}}." }),
    ]);
    await runTurn(c.id, { backend });
    expect(backend.calls).toHaveLength(2);
    const [m] = await outbound(c.id);
    expect(m.content).toBe("Call or +91 99999 00000.");
    expect((await lastTurn(c.id)).scrubbed).toBe(true);
    expect(await eventsOf("scrub_strip")).toHaveLength(1);
  });

  it("sends a number again, after the call-directly line, when a guard had to remove it with a digit glued to it", async () => {
    const c = await conv();
    await storeReporterMessage(c.id, { kind: "text", content: "helpline?" });
    const backend = new FakeBackend([okReply({ reply: "Call {{PHONE:helpline}}5 now." })]);
    await runTurn(c.id, { backend });
    const [m] = await outbound(c.id);
    expect(m.content).toBe("Call now.\n\nPlease call them directly and they will guide you. +91 99999 00000");
    expect(m.contentTemplate).toContain("{{PHONE:helpline}}");
    expect((await eventsOf("number_restored")).map((e) => e.payload)).toEqual([{ turnId: m.turnId, count: 1 }]);
  });

  it("falls back with a real number, recording empty_reply, when the reply renders empty", async () => {
    const c = await conv();
    await storeReporterMessage(c.id, { kind: "text", content: "Lucknow" });
    const r = await runTurn(c.id, { backend: new FakeBackend([okReply({ reply: "  " })]) });
    expect(r.kind).toBe("fallback");
    const [m] = await outbound(c.id);
    expect(m.origin).toBe("fallback");
    expect(m.content).toContain("+91 99999 00000");
    const [claude, fallback] = await turnsOf(c.id);
    expect([claude.status, claude.error]).toEqual(["failed", "empty_reply: the reply was empty after rendering"]);
    expect([fallback.id, fallback.status, fallback.error]).toEqual([r.turnId, "fallback", "empty_reply"]);
    expect((await eventsOf("empty_reply")).map((e) => e.payload)).toEqual([{ turnId: claude.id }]);
  });

  it("falls back when the guards leave nothing to send", async () => {
    const c = await conv();
    await storeReporterMessage(c.id, { kind: "text", content: "Surat" });
    const r = await runTurn(c.id, { backend: new FakeBackend([okReply({ reply: "9876543210" })]) });
    expect(r.kind).toBe("fallback");
    expect((await outbound(c.id))[0].content).toContain("Arham Animal Ambulance, Surat");
    expect(await eventsOf("empty_reply")).toHaveLength(1);
  });

  it("appends no guessed unit card to a reply that hands the reporter to a person", async () => {
    const c = await conv();
    await storeReporterMessage(c.id, { kind: "text", content: "ghatkopar, I want to talk to someone" });
    const backend = new FakeBackend([async (input: TurnInput) => {
      await findAmbulancesImpl(input.toolContext!, { city: "Mumbai", area: "Ghatkopar", query: "ghatkopar" });
      return okReply({ reply: "Our team will help you.", intent: "ambulance", needs_human: true });
    }]);
    await runTurn(c.id, { backend });
    const [m] = await outbound(c.id);
    expect(m.content).toBe("Our team will help you.");
  });

  it("finishes the turn failed with delivery_failed when the reply was not delivered, keeping the burst answered", async () => {
    setFetchForTests((async () => new Response(JSON.stringify({ message: "rejected" }), { status: 400 })) as typeof fetch);
    const c = await createConversation({ phone: "+919876500993", language: "en", welcomedAt: new Date() });
    const sent = await storeReporterMessage(c.id, { kind: "text", content: "surat" });
    const r = await runTurn(c.id, { backend: new FakeBackend([okReply({ reply: "Please call {{PHONE:helpline}}.", language: "hi" })]) });
    expect(r.kind).toBe("failed");
    const t = await lastTurn(c.id);
    expect([t.id, t.status, t.error]).toEqual([r.turnId, "failed", "delivery_failed"]);
    const [inbound] = await getDb().select().from(messages).where(eq(messages.id, sent.id!));
    expect(inbound.answeredTurnId).toBe(r.turnId);
    const row = await conversationRow(c.id);
    expect([row.flagged, row.flagReason, row.language]).toEqual([true, "send_failed", "hi"]);
    expect((await getWorkerState()).lastOkTurnAt).toBeNull();
  });

  it("audits tool uses the SDK refused beside the calls the tools recorded, on every attempt, and records extra usage", async () => {
    const c = await conv();
    await storeReporterMessage(c.id, { kind: "text", content: "ghatkopar" });
    const backend = new FakeBackend([
      withToolUses(errorResult("TRANSIENT"), [{ name: "Bash", isError: true }]),
      async (input: TurnInput) => {
        await findAmbulancesImpl(input.toolContext!, { city: "Mumbai", area: "Ghatkopar", query: "ghatkopar" });
        return withToolUses(okReply({ reply: "Please call the Ghatkopar ambulance.", intent: "ambulance" }), [
          { name: "mcp__arham__find_ambulances", isError: false },
          { name: "mcp__arham__find_clinics", isError: true },
          { name: "StructuredOutput", isError: false },
        ], { extraUsage: true });
      },
    ]);
    await runTurn(c.id, { backend });
    const t = await lastTurn(c.id);
    const calls = t.toolCalls as { name: string; input: unknown; output: unknown; durationMs: number; error?: unknown }[];
    expect(calls.map((x) => x.name)).toEqual(["find_ambulances", "Bash", "mcp__arham__find_clinics"]);
    expect(calls.slice(1)).toEqual([
      { name: "Bash", input: null, output: null, durationMs: 0, error: { errorClass: "SdkRejected" } },
      { name: "mcp__arham__find_clinics", input: null, output: null, durationMs: 0, error: { errorClass: "SdkRejected" } },
    ]);
    expect(t.usage).toMatchObject({ input_tokens: 10, extraUsage: true });
  });

  it("keeps the tool calls on a turn that fell back", async () => {
    const c = await conv();
    await storeReporterMessage(c.id, { kind: "text", content: "surat" });
    const backend = new FakeBackend([async (input: TurnInput) => {
      await findAmbulancesImpl(input.toolContext!, { city: "Surat", area: null, query: "surat" });
      return withToolUses(errorResult("TRANSIENT", "assistant error: server_error"), [{ name: "mcp__arham__find_ambulances", isError: false }, { name: "Bash", isError: true }]);
    }]);
    const r = await runTurn(c.id, { backend });
    expect(r.kind).toBe("fallback");
    const [claude] = await turnsOf(c.id);
    expect([claude.status, claude.error, claude.sessionId]).toEqual(["failed", "claude_transient: assistant error: server_error", null]);
    expect((claude.toolCalls as { name: string }[]).map((x) => x.name)).toEqual(["find_ambulances", "find_ambulances", "Bash", "Bash"]);
  });

  it("tells the model the newest location reported in the last five turns of the past 24 h", async () => {
    const c = await conv();
    const ago = (ms: number) => new Date(Date.now() - ms);
    const hour = 3_600_000;
    await getDb().insert(turns).values([
      { conversationId: c.id, status: "ok", structuredOutput: { location: { city: "Pune", area: "Kothrud" } }, createdAt: ago(30 * hour) },
      { conversationId: c.id, status: "ok", structuredOutput: { location: { city: "Mumbai", area: "Ghatkopar" } }, createdAt: ago(3 * hour) },
      { conversationId: c.id, status: "fallback", structuredOutput: { matched: 0, matchType: null, sent: "helpline" }, createdAt: ago(2 * hour) },
      { conversationId: c.id, status: "ok", structuredOutput: { location: { city: null, area: null } }, createdAt: ago(hour) },
    ]);
    await storeReporterMessage(c.id, { kind: "text", content: "still waiting" });
    const backend = new FakeBackend([okReply({ reply: "Okay." })]);
    await runTurn(c.id, { backend });
    expect(backend.calls[0].prompt).toContain("Location known so far: Ghatkopar, Mumbai");
  });

  it.each([
    ["only older than 24 h", (ms: number) => [{ at: 25 * ms, loc: true }]],
    ["behind five newer turns without one", (ms: number) => [{ at: 10 * ms, loc: true }, ...[5, 4, 3, 2, 1].map((n) => ({ at: n * ms, loc: false }))]],
  ] as const)("knows no location when the one reported is %s", async (_label, plan) => {
    const c = await conv();
    const hour = 3_600_000;
    await getDb().insert(turns).values(plan(hour).map(({ at, loc }) => ({
      conversationId: c.id, status: "ok" as const, structuredOutput: loc ? { location: { city: "Mumbai", area: "Ghatkopar" } } : null, createdAt: new Date(Date.now() - at),
    })));
    await storeReporterMessage(c.id, { kind: "text", content: "hello?" });
    const backend = new FakeBackend([okReply({ reply: "Okay." })]);
    await runTurn(c.id, { backend });
    expect(backend.calls[0].prompt).toContain("Location known so far: unknown");
  });

  it("lists as shared only the handles in replies whose send did not fail", async () => {
    const c = await conv();
    const [h1, h2, h3, h4] = [ids.ghatkopar, ids.malad, ids.andheri, ids.bandra].map((id) => makeHandle("ambulance", c.id, id));
    const old = await createTurn({ conversationId: c.id, status: "ok" });
    await finishTurn(old.id, {
      handles: {
        [h1]: { kind: "ambulance", id: ids.ghatkopar }, [h2]: { kind: "ambulance", id: ids.malad },
        [h3]: { kind: "ambulance", id: ids.andheri }, [h4]: { kind: "ambulance", id: ids.bandra },
      },
    });
    const reply = (template: string, deliveryStatus: string | null, minutesAgo: number) => ({
      conversationId: c.id, role: "assistant" as const, origin: "agent" as const, content: "x", contentTemplate: template, deliveryStatus,
      createdAt: new Date(Date.now() - minutesAgo * 60_000),
    });
    await getDb().insert(messages).values([
      reply(`Call {{AMB:${h1}}}`, "sent", 4),
      reply(`Call {{AMB:${h2}}}`, "failed", 3),
      reply(`Call {{AMB:${h3}}} or {{AMB:amb_zzzzzzzz}} or {{PHONE:helpline}}, or {{AMB:${h1}}} again`, "test_skipped", 2),
      reply(`Or {{AMB:${h4}}}`, null, 1),
    ]);
    await storeReporterMessage(c.id, { kind: "text", content: "not reachable" });
    const backend = new FakeBackend([okReply({ reply: "Okay." })]);
    await runTurn(c.id, { backend });
    expect(backend.calls[0].prompt).toContain(`Handles already shared in this chat: ${h1}, ${h3}, ${h4}\n`);
  });

  it("uses the injected clock for the pause check, the prompt's time and the transcript", async () => {
    const c = await conv();
    await pauseClaude(new Date(Date.now() + 60_000), "LIMITED");
    await storeReporterMessage(c.id, { kind: "text", content: "surat" });
    const later = new Date(Date.now() + 36 * 3_600_000);
    const backend = new FakeBackend([okReply({ reply: "Okay." })]);
    expect((await runTurn(c.id, { backend, now: () => later })).kind).toBe("ok");
    expect(backend.calls[0].prompt).toContain(`Current time: ${formatIst(later)}`);
    // Written 36 h before "now", so the transcript stamps the reporter's message with its date.
    expect(backend.calls[0].prompt).toMatch(/\[\d{1,2} [A-Z][a-z]{2}(?: \d{4})? \d{2}:\d{2}\] Reporter: surat/);
  });

  it("flags needs_human without replacing a reason set mid-turn, and never clears a flag from the gathered snapshot", async () => {
    const flagMidTurn = (id: string, needsHuman: boolean) => async () => {
      await getDb().update(conversations).set({ flagged: true, flagReason: "dispatcher" }).where(eq(conversations.id, id));
      return okReply({ reply: "Okay, call {{PHONE:helpline}}.", needs_human: needsHuman });
    };
    for (const needsHuman of [true, false]) {
      const c = await conv();
      await storeReporterMessage(c.id, { kind: "text", content: "I want a person" });
      await runTurn(c.id, { backend: new FakeBackend([flagMidTurn(c.id, needsHuman)]) });
      const row = await conversationRow(c.id);
      expect([row.flagged, row.flagReason]).toEqual([true, "dispatcher"]);
    }
  });

  it("falls back, recording claude_backend_error without the error's text, when no backend can be built", async () => {
    vi.spyOn(agent, "getBackend").mockImplementation(() => {
      throw new Error("cannot start the CLI for +919876543210");
    });
    const c = await conv();
    await storeReporterMessage(c.id, { kind: "text", content: "surat" });
    const r = await runTurn(c.id);
    expect(r.kind).toBe("fallback");
    const [claude, fallback] = await turnsOf(c.id);
    expect([claude.status, claude.error]).toEqual(["failed", "backend_unavailable: Error"]);
    expect([fallback.id, fallback.error]).toEqual([r.turnId, "backend_unavailable"]);
    expect((await eventsOf("claude_backend_error")).map((e) => e.payload)).toEqual([{ turnId: claude.id, errorClass: "Error" }]);
    expect((await outbound(c.id))[0].content).toContain("Arham Animal Ambulance, Surat");
  });

  it("retries a backend that throws once, as a transient failure, then falls back", async () => {
    let runs = 0;
    const backend: LLMBackend = {
      name: "throwing",
      runTurn: async () => {
        runs += 1;
        throw new TypeError("socket closed by +919876543210");
      },
    };
    const c = await conv();
    await storeReporterMessage(c.id, { kind: "text", content: "surat" });
    expect((await runTurn(c.id, { backend })).kind).toBe("fallback");
    expect(runs).toBe(2);
    const [claude] = await turnsOf(c.id);
    expect(claude.error).toBe("claude_transient: backend threw TypeError");
    expect((await eventsOf("claude_backend_error")).map((e) => e.payload)).toEqual([
      { turnId: claude.id, errorClass: "TypeError" },
      { turnId: claude.id, errorClass: "TypeError" },
    ]);
  });

  it("puts the backend's message on the turn row and in the events, never in a log line, and logs no reply text or digits", async () => {
    const lines: unknown[][] = [];
    for (const level of ["debug", "info", "warn", "error"] as const) {
      vi.spyOn(log, level).mockImplementation(((...args: unknown[]) => void lines.push(args)) as never);
    }
    const scrubbed = await conv();
    await storeReporterMessage(scrubbed.id, { kind: "text", content: "surat" });
    await runTurn(scrubbed.id, { backend: new FakeBackend([okReply({ reply: "Ring 9876543210 please." })]) });
    const failed = await conv();
    await storeReporterMessage(failed.id, { kind: "text", content: "rajkot" });
    await runTurn(failed.id, { backend: new FakeBackend([errorResult("AUTH", "not logged in as reporter +919812345678")]) });
    const [claude] = await turnsOf(failed.id);
    expect(claude.error).toBe("claude_auth: not logged in as reporter +919812345678");
    expect((await eventsOf("claude_auth_error"))[0].payload).toMatchObject({ message: "not logged in as reporter +919812345678" });
    expect(lines.length).toBeGreaterThan(0);
    const logged = JSON.stringify(lines);
    expect(logged).not.toMatch(/Ring|please|not logged in|reporter \+|9876543210|9812345678/);
  });
});

describe("the Claude turn's time budget, audit totals and failure handling", () => {
  beforeEach(async () => { await stopBoss(); await resetDb(); ids = await seedDirectory(); });
  afterEach(async () => {
    await stopBoss();
    vi.restoreAllMocks();
  });

  /** A monotonic clock the steps move forward, standing in for the time each backend call takes. */
  const fakeClock = () => {
    const clock = { ms: 0, nowMs: () => clock.ms };
    return clock;
  };

  it("gives each backend call what is left of the turn's budget, at most the configured timeout", async () => {
    const c = await conv();
    await storeReporterMessage(c.id, { kind: "text", content: "surat" });
    const clock = fakeClock();
    const timeouts: number[] = [];
    const backend = new FakeBackend([
      (input: TurnInput) => {
        timeouts.push(input.timeoutMs);
        clock.ms += 50_000;
        return errorResult("TRANSIENT", "mcp_not_connected: arham status=pending");
      },
      (input: TurnInput) => {
        timeouts.push(input.timeoutMs);
        return okReply({ reply: "Which area of Surat?" });
      },
    ]);
    expect((await runTurn(c.id, { backend, nowMs: clock.nowMs })).kind).toBe("ok");
    // 100 s budget less a 10 s reserve: 45 s (the configured timeout) first, then the 40 s left.
    expect(timeouts).toEqual([45_000, 40_000]);
  });

  it("skips the retry and falls back at once when the budget cannot cover another call", async () => {
    const c = await conv();
    await storeReporterMessage(c.id, { kind: "text", content: "surat" });
    const clock = fakeClock();
    const backend = new FakeBackend([() => {
      clock.ms += 80_000;
      return errorResult("TRANSIENT", "mcp_not_connected: arham status=pending");
    }]);
    const r = await runTurn(c.id, { backend, nowMs: clock.nowMs });
    expect(r.kind).toBe("fallback");
    expect(backend.calls).toHaveLength(1);
    const [claude, fallback] = await turnsOf(c.id);
    expect([claude.status, fallback.error]).toEqual(["failed", "claude_transient"]);
    expect((await eventsOf("retry_skipped")).map((e) => e.payload)).toEqual([
      { turnId: claude.id, purpose: "retry", reason: "budget", remainingMs: 10_000 },
    ]);
    expect((await outbound(c.id))[0].content).toContain("Arham Animal Ambulance, Surat");
  });

  it("never retries a transient failure that was a timeout", async () => {
    const c = await conv();
    await storeReporterMessage(c.id, { kind: "text", content: "surat" });
    const backend = new FakeBackend([errorResult("TRANSIENT", "turn timed out"), okReply({ reply: "too late" })]);
    const r = await runTurn(c.id, { backend });
    expect(r.kind).toBe("fallback");
    expect(backend.calls).toHaveLength(1);
    const [claude] = await turnsOf(c.id);
    expect(claude.error).toBe("claude_transient: turn timed out");
    expect((await eventsOf("retry_skipped")).map((e) => e.payload)).toEqual([
      { turnId: claude.id, purpose: "retry", reason: "timed_out", remainingMs: expect.any(Number) },
    ]);
  });

  it.each([
    ["token", "Call 9876543210 now.", "Call now."],
    ["dispatch", "We are sending the ambulance now. Call {{PHONE:helpline}}.", "Please call them directly and they will guide you. Call +91 99999 00000."],
  ] as const)("skips a %s correction the budget cannot cover and guards the draft it has", async (purpose, reply, sent) => {
    const c = await conv();
    await storeReporterMessage(c.id, { kind: "text", content: "surat" });
    const clock = fakeClock();
    const backend = new FakeBackend([() => {
      clock.ms += 80_000;
      return okReply({ reply });
    }]);
    expect((await runTurn(c.id, { backend, nowMs: clock.nowMs })).kind).toBe("ok");
    expect(backend.calls).toHaveLength(1);
    expect((await outbound(c.id))[0].content).toBe(sent);
    const t = await lastTurn(c.id);
    expect((await eventsOf("retry_skipped")).map((e) => e.payload)).toEqual([{ turnId: t.id, purpose, reason: "budget", remainingMs: 10_000 }]);
  });

  it("sums usage over every attempt and records the turn's wall-clock latency", async () => {
    const c = await conv();
    await storeReporterMessage(c.id, { kind: "text", content: "helpline?" });
    const clock = fakeClock();
    const backend = new FakeBackend([
      () => {
        clock.ms += 3_000;
        return withToolUses(okReply({ reply: "Call 9876543210 now." }), [], { extraUsage: true });
      },
      () => {
        clock.ms += 2_000;
        return okReply({ reply: "Call {{PHONE:helpline}} now." });
      },
    ]);
    await runTurn(c.id, { backend, nowMs: clock.nowMs });
    const t = await lastTurn(c.id);
    expect(t.usage).toEqual({ input_tokens: 20, output_tokens: 10, backendCalls: 2, extraUsage: true });
    expect(t.latencyMs).toBe(5_000);
  });

  it("keeps model-typed digits out of every event payload", async () => {
    const c = await conv();
    await storeReporterMessage(c.id, { kind: "text", content: "helpline?" });
    await runTurn(c.id, { backend: new FakeBackend([okReply({ reply: "Call {{PHONE:9876543210}} or {{AMB:98765 43210}} now." })]) });
    const evs = await getDb().select().from(events).where(eq(events.conversationId, c.id));
    expect(evs.map((e) => e.kind)).toEqual(["scrub_strip"]);
    expect(JSON.stringify(evs.map((e) => e.payload))).not.toMatch(/98765|43210/);
  });

  describe("a handle whose unit was deactivated after it was shared", () => {    const staleHandle = async (conversationId: string) => {
      const h = makeHandle("ambulance", conversationId, ids.ghatkopar);
      const old = await createTurn({ conversationId, status: "ok" });
      await finishTurn(old.id, { handles: { [h]: { kind: "ambulance", id: ids.ghatkopar } } });
      await getDb().update(ambulances).set({ active: false }).where(eq(ambulances.id, ids.ghatkopar));
      return h;
    };

    it("gets one correction that asks for a fresh lookup, and the retired number is never sent", async () => {
      const c = await conv();
      const h = await staleHandle(c.id);
      await storeReporterMessage(c.id, { kind: "text", content: "number phir se bhejo" });
      const backend = new FakeBackend([
        okReply({ reply: `Number: {{AMB:${h}}}`, intent: "ambulance" }),
        okReply({ reply: "Please call our helpline {{PHONE:helpline}}.", intent: "ambulance" }),
      ]);
      await runTurn(c.id, { backend });
      expect(backend.calls).toHaveLength(2);
      expect(backend.calls[1].prompt).toContain(staleHandleNote([h]));
      expect(backend.calls[1].prompt).not.toContain(TOKEN_CORRECTION_NOTE);
      const out = await outbound(c.id);
      expect(out.map((m) => m.content)).toEqual(["Please call our helpline +91 99999 00000."]);
      expect(await eventsOf("stale_handle")).toHaveLength(0);
      expect(await eventsOf("unknown_handle")).toHaveLength(0);
    });

    it("records stale_handle, not unknown_handle, when the correction repeats it, and sends the helpline card instead of an empty call line", async () => {
      const c = await conv();
      const h = await staleHandle(c.id);
      await storeReporterMessage(c.id, { kind: "text", content: "number phir se bhejo" });
      const backend = new FakeBackend([okReply({ reply: `Is number par call karein: {{AMB:${h}}}`, intent: "ambulance" })]);
      await runTurn(c.id, { backend });
      expect(backend.calls).toHaveLength(2);
      const [m] = await outbound(c.id);
      const card = buildHelplineCard("+919999900000", "en");
      expect(m.content).toBe(`Is number par call karein:\n\n${card}`);
      expect(m.contentTemplate).toBe(`Is number par call karein:\n\n${card.replace("+91 99999 00000", "{{PHONE:helpline}}")}`);
      expect(m.content).not.toContain("70000 00001");
      expect((await eventsOf("stale_handle")).map((e) => e.payload)).toEqual([{ turnId: m.turnId, handles: [h] }]);
      expect(await eventsOf("unknown_handle")).toHaveLength(0);
    });
  });

  it("sends again, with its token in the template, a number an earlier draft gave that the corrected reply dropped", async () => {
    const c = await conv();
    const h = makeHandle("ambulance", c.id, ids.ghatkopar);
    const old = await createTurn({ conversationId: c.id, status: "ok" });
    await finishTurn(old.id, { handles: { [h]: { kind: "ambulance", id: ids.ghatkopar } } });
    await storeReporterMessage(c.id, { kind: "text", content: "ghatkopar" });
    const backend = new FakeBackend([
      okReply({ reply: `Call {{AMB:${h}}} or 9876543210.`, intent: "ambulance" }),
      okReply({ reply: "Please call the Ghatkopar ambulance right away.", intent: "ambulance" }),
    ]);
    await runTurn(c.id, { backend });
    expect(backend.calls).toHaveLength(2);
    const [m] = await outbound(c.id);
    const line = "Please call them directly and they will guide you.";
    expect(m.content).toBe(`Please call the Ghatkopar ambulance right away.\n\n${line} +91 70000 00001`);
    expect(m.contentTemplate).toBe(`Please call the Ghatkopar ambulance right away.\n\n${line} {{AMB:${h}}}`);
    expect((await eventsOf("number_restored")).map((e) => e.payload)).toEqual([{ turnId: m.turnId, count: 1 }]);
    expect((await lastTurn(c.id)).scrubbed).toBe(false);
  });

  it("flags the conversation when any draft of the turn asked for a human", async () => {
    const c = await conv();
    await storeReporterMessage(c.id, { kind: "text", content: "I want a person" });
    const backend = new FakeBackend([
      okReply({ reply: "Call 9876543210.", needs_human: true }),
      okReply({ reply: "Please call our helpline {{PHONE:helpline}}.", needs_human: false }),
    ]);
    await runTurn(c.id, { backend });
    const row = await conversationRow(c.id);
    expect([row.flagged, row.flagReason]).toEqual([true, "needs_human"]);
    expect((await lastTurn(c.id)).structuredOutput).toMatchObject({ reply: "Please call our helpline {{PHONE:helpline}}.", needs_human: true });
  });

  it("falls back with internal_error, the error's class only, when the turn throws unexpectedly", async () => {
    vi.spyOn(render, "renderReply").mockRejectedValueOnce(new Error("render broke on +919876543210"));
    const error = vi.spyOn(log, "error").mockImplementation(() => undefined);
    const c = await conv();
    await storeReporterMessage(c.id, { kind: "text", content: "surat" });
    const r = await runTurn(c.id, { backend: new FakeBackend([okReply({ reply: "Okay." })]) });
    expect(r.kind).toBe("fallback");
    expect(error).toHaveBeenCalledWith({ conversationId: c.id, errorClass: "Error" }, "claude turn failed unexpectedly");
    expect(JSON.stringify(error.mock.calls)).not.toContain("9876543210");
    const [claude, fallback] = await turnsOf(c.id);
    expect([claude.status, claude.error]).toEqual(["failed", "internal_error: Error"]);
    expect([fallback.id, fallback.error]).toEqual([r.turnId, "internal_error"]);
    expect((await outbound(c.id)).map((m) => m.origin)).toEqual(["fallback"]);
  });

  it.each([
    ["AUTH", errorResult("AUTH", "not logged in")],
    ["LIMITED without a reset time", errorResult("LIMITED", "usage limit")],
  ] as const)("pauses Claude for 15 minutes on %s", async (_label, result) => {
    const c = await conv();
    await storeReporterMessage(c.id, { kind: "text", content: "surat" });
    const at = new Date();
    expect((await runTurn(c.id, { backend: new FakeBackend([result]), now: () => at })).kind).toBe("fallback");
    const state = await getWorkerState();
    expect([state.claudePausedUntil?.getTime(), state.pauseReason]).toEqual([at.getTime() + 15 * 60_000, result.ok ? null : result.kind]);
  });

  it.each([
    ["LIMITED", errorResult("LIMITED", "usage limit"), "claude_limited"],
    ["AUTH", errorResult("AUTH", "not logged in"), "claude_auth_error"],
  ] as const)("pauses Claude on %s from a corrective retry and still delivers the guarded draft it has", async (_kind, result, event) => {
    const c = await conv();
    await storeReporterMessage(c.id, { kind: "text", content: "helpline?" });
    const backend = new FakeBackend([okReply({ reply: "Call {{PHONE:helpline}} now. Or try 9876543210." }), result]);
    expect((await runTurn(c.id, { backend })).kind).toBe("ok");
    expect(backend.calls).toHaveLength(2);
    expect((await outbound(c.id))[0].content).toBe("Call +91 99999 00000 now. Or try.");
    expect(await isClaudePaused()).toBe(true);
    expect(await eventsOf(event)).toHaveLength(1);
    const t = await lastTurn(c.id);
    expect([t.status, t.scrubbed]).toEqual(["ok", true]);
  });
});
