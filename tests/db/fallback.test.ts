import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { resetDb, createConversation } from "../helpers/db";
import { seedDirectory } from "../helpers/fixtures";
import { getDb } from "@/server/db/client";
import { conversations, events, messages, turns, workerState } from "@/server/db/schema";
import { storeReporterMessage } from "@/server/inbound/store";
import * as store from "@/server/inbound/store";
import { setFetchForTests } from "@/server/interakt/client";
import { loadActiveAmbulances } from "@/server/directory/repo";
import { matchAmbulances } from "@/server/directory/matcher";
import { buildHelplineCard } from "@/server/messages/cards";
import { log } from "@/server/log";
import { gatherPending } from "@/server/worker/gather";
import { runFallbackTurn } from "@/server/worker/fallback";
import { pauseClaude, isClaudePaused, clearClaudePause, heartbeat, getWorkerState } from "@/server/worker/pause";

const testConversation = (language: "en" | "hi" | "mr" | "gu" | null = null) =>
  createConversation({ isTest: true, phone: `+91TEST_${Math.random().toString(36).slice(2, 8)}`, language });

async function fallbackOn(conversationId: string) {
  const g = (await gatherPending(conversationId))!;
  const r = await runFallbackTurn({ conversation: g.conversation, pending: g.pending, reason: "test" });
  const [conv] = await getDb().select().from(conversations).where(eq(conversations.id, conversationId));
  return { ...r, conv };
}

async function fallbackFor(text: string, language: "en" | "hi" | "mr" | "gu" | null = null) {
  const c = await testConversation(language);
  await storeReporterMessage(c.id, { kind: "text", content: text });
  return fallbackOn(c.id);
}

describe("pause state", () => {
  beforeEach(resetDb);
  it("pauses and clears", async () => {
    expect(await isClaudePaused()).toBe(false);
    await pauseClaude(new Date(Date.now() + 60_000), "LIMITED");
    expect(await isClaudePaused()).toBe(true);
    expect((await getWorkerState()).pauseReason).toBe("LIMITED");
    await clearClaudePause();
    expect(await isClaudePaused()).toBe(false);
    await heartbeat();
    expect((await getWorkerState()).lastHeartbeatAt).not.toBeNull();
  });
  it("treats an expired pause as not paused", async () => {
    await getWorkerState();
    await getDb().update(workerState).set({ claudePausedUntil: new Date(Date.now() - 1000), pauseReason: "LIMITED" });
    expect(await isClaudePaused()).toBe(false);
  });
  it("is no longer paused at the exact instant the pause ends", async () => {
    const until = new Date(Date.now() + 10 * 60_000);
    await pauseClaude(until, "LIMITED");
    expect(await isClaudePaused(new Date(until.getTime() - 1))).toBe(true);
    expect(await isClaudePaused(until)).toBe(false);
  });
  it("never shortens a pause: a shorter later pause keeps the longer one and its reason, a longer one extends it", async () => {
    const now = Date.now();
    const pause = async () => {
      const s = await getWorkerState();
      return [s.claudePausedUntil?.getTime(), s.pauseReason];
    };
    await pauseClaude(new Date(now + 60 * 60_000), "AUTH");
    await pauseClaude(new Date(now + 5 * 60_000), "LIMITED");
    expect(await pause()).toEqual([now + 60 * 60_000, "AUTH"]);
    await pauseClaude(new Date(now + 2 * 60 * 60_000), "LIMITED");
    expect(await pause()).toEqual([now + 2 * 60 * 60_000, "LIMITED"]);
  });
  it("pauses for at least a minute, even when asked to pause until a time already past", async () => {
    const now = new Date();
    await pauseClaude(new Date(now.getTime() - 1000), "LIMITED", now);
    expect((await getWorkerState()).claudePausedUntil?.getTime()).toBe(now.getTime() + 60_000);
    expect(await isClaudePaused()).toBe(true);
  });
  it("replaces an expired pause and its reason", async () => {
    await getWorkerState();
    await getDb().update(workerState).set({ claudePausedUntil: new Date(Date.now() - 60_000), pauseReason: "AUTH" });
    const until = new Date(Date.now() + 10 * 60_000);
    await pauseClaude(until, "LIMITED");
    const s = await getWorkerState();
    expect([s.claudePausedUntil?.getTime(), s.pauseReason]).toEqual([until.getTime(), "LIMITED"]);
  });
});

describe("runFallbackTurn", () => {
  beforeEach(async () => { await resetDb(); await seedDirectory(); });
  afterEach(() => {
    setFetchForTests(null);
    vi.restoreAllMocks();
  });

  it("delivers a single card for a unique match in the reporter's language", async () => {
    const r = await fallbackFor("ghatkopar me kutta ghayal hai");
    expect(r.message.content).toContain("Arham Animal Ambulance, Ghatkopar");
    expect(r.message.content).toContain("+91 70000 00001");
    expect(r.message.content).toContain("कृपया उन्हें तुरंत कॉल करें");
    expect(r.message.origin).toBe("fallback");
    expect(r.turn.status).toBe("fallback");
    expect(r.conv.flagged).toBe(true);
    expect(r.conv.flagReason).toBe("claude_unavailable");
    expect(r.conv.language).toBe("hi");
  });

  it("finds a Gujarati-script city and answers in Gujarati", async () => {
    const r = await fallbackFor("સુરતમાં ગાય ઘાયલ છે");
    expect(r.message.content).toContain("Arham Animal Ambulance, Surat");
    expect(r.message.content).toContain("કૃપા કરીને તેમને તરત જ કૉલ કરો");
  });

  it("delivers a multi card with partner labels for Rajkot", async () => {
    const r = await fallbackFor("injured cow in Rajkot", "en");
    expect(r.message.content).toContain("Here are the animal ambulances for your area:");
    expect(r.message.content).toContain("2 ambulances are available in Rajkot");
    expect(r.message.content).toContain("(operated by Blue Cross)");
    expect(r.message.content).toContain("(operated by Hope for Indies Trust)");
    expect(r.turn.structuredOutput).toEqual({ matched: 2, matchType: "area", sent: "units" });
  });

  it("sends the helpline card when nothing matches", async () => {
    const r = await fallbackFor("Lucknow", "en");
    expect(r.message.content).toContain("I couldn't find that area right now.");
    expect(r.message.content).toContain("+91 99999 00000");
  });

  it("sends the English helpline card, and no unit number, for a burst with no text (a sticker)", async () => {
    const c = await testConversation();
    await storeReporterMessage(c.id, { kind: "sticker", content: "" });
    const r = await fallbackOn(c.id);
    expect(r.message.content).toBe(`I couldn't find that area right now.\n${buildHelplineCard("+919999900000", "en")}`);
    expect(r.message.content.match(/\+91 \d{5} \d{5}/g)).toEqual(["+91 99999 00000"]);
  });

  it("sends the helpline card alone when an exact city has more than three units", async () => {
    const probe = matchAmbulances(await loadActiveAmbulances(), { query: "injured dog in Mumbai" });
    expect(probe.match).toBe("city");
    expect(probe.candidates.length).toBeGreaterThan(3);
    const r = await fallbackFor("injured dog in Mumbai", "en");
    const [cardFirstLine] = buildHelplineCard("+919999900000", "en").split("\n");
    expect(r.message.content.split("\n")[0]).toBe(cardFirstLine);
    expect(r.message.content).not.toContain("Please call our helpline:");
    expect(r.message.content.match(/\+91 \d{5} \d{5}/g)).toEqual(["+91 99999 00000"]);
    expect(r.turn.structuredOutput).toEqual({ matched: probe.candidates.length, matchType: "city", sent: "helpline" });
  });

  it.each([
    ["Rajkott", "fuzzy"],
    ["Goregaon", "neighbour"],
  ] as const)("sends the helpline card, not a guessed unit, when %s is only a %s match", async (query, matchType) => {
    const probe = matchAmbulances(await loadActiveAmbulances(), { query });
    expect(probe.match).toBe(matchType);
    expect(probe.candidates.length).toBeGreaterThan(0);
    const r = await fallbackFor(query, "en");
    expect(r.message.content).toContain("I couldn't find that area right now.");
    expect(r.message.content.match(/\+91 \d{5} \d{5}/g)).toEqual(["+91 99999 00000"]);
    const [t] = await getDb().select().from(turns).where(eq(turns.id, r.turn.id));
    expect(t.structuredOutput).toEqual({ matched: probe.candidates.length, matchType, sent: "helpline" });
  });

  it("keeps a flag reason already on the conversation, even one set after the burst was gathered", async () => {
    const c = await testConversation();
    await storeReporterMessage(c.id, { kind: "text", content: "Surat" });
    const g = (await gatherPending(c.id))!;
    // A dispatcher flags the conversation while the turn runs; the gathered snapshot still says unflagged.
    await getDb().update(conversations).set({ flagged: true, flagReason: "needs_human" }).where(eq(conversations.id, c.id));
    await runFallbackTurn({ conversation: g.conversation, pending: g.pending, reason: "test" });
    const [conv] = await getDb().select().from(conversations).where(eq(conversations.id, c.id));
    expect([conv.flagged, conv.flagReason]).toEqual([true, "needs_human"]);
  });

  it("keeps send_failed as the flag, and says so in the event, when the fallback reply itself fails to send", async () => {
    setFetchForTests((async () => new Response(JSON.stringify({ message: "rejected" }), { status: 400 })) as typeof fetch);
    const c = await createConversation({ phone: "+919876543220" });
    await storeReporterMessage(c.id, { kind: "text", content: "Surat" });
    const r = await fallbackOn(c.id);
    expect(r.message.deliveryStatus).toBe("failed");
    expect([r.conv.flagged, r.conv.flagReason]).toEqual([true, "send_failed"]);
    const [ev] = await getDb().select().from(events).where(eq(events.kind, "fallback_turn"));
    expect(ev.payload).toMatchObject({ sent: "unit", deliveryStatus: "failed" });
  });

  it("records a fallback_turn event naming the turn, the match and what was sent", async () => {
    const r = await fallbackFor("ghatkopar me kutta ghayal hai");
    const evs = await getDb().select().from(events).where(eq(events.kind, "fallback_turn"));
    expect(evs.map((e) => [e.conversationId, e.payload])).toEqual([
      [r.conv.id, { reason: "test", turnId: r.turn.id, matched: 1, matchType: "area", sent: "unit", deliveryStatus: "test_skipped" }],
    ]);
  });

  it("still answers and finishes the turn when the fallback_turn event cannot be recorded", async () => {
    const record = vi.spyOn(store, "recordEvent").mockRejectedValueOnce(new Error("events table unavailable"));
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const r = await fallbackFor("Surat");
    expect(record).toHaveBeenCalledTimes(1);
    expect(r.message.content).toContain("Arham Animal Ambulance, Surat");
    expect(warn).toHaveBeenCalledWith({ conversationId: r.conv.id }, "fallback_turn event not recorded");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("events table unavailable");
    const [t] = await getDb().select().from(turns).where(eq(turns.id, r.turn.id));
    expect(t.structuredOutput).toEqual({ matched: 1, matchType: "area", sent: "unit" });
  });

  it.each([
    ["a bare greeting", { kind: "text", content: "hi" }],
    ["a Devanagari greeting", { kind: "text", content: "नमस्ते 🙏" }],
    ["a sticker", { kind: "sticker", content: "" }],
    ["a caption-less photo", { kind: "image", content: "", mediaUrl: "https://x/p.jpg" }],
  ] as const)("leaves the language unset after %s, so a later real message decides it", async (_label, message) => {
    const c = await testConversation();
    await storeReporterMessage(c.id, message);
    const r = await fallbackOn(c.id);
    expect(r.message.content).toContain("+91 99999 00000");
    expect(r.conv.language).toBeNull();
  });

  it("stores the detected language once the burst has real text beside a greeting", async () => {
    const c = await testConversation();
    await storeReporterMessage(c.id, { kind: "text", content: "hi" });
    await storeReporterMessage(c.id, { kind: "text", content: "सूरत में गाय घायल है" });
    const r = await fallbackOn(c.id);
    expect(r.conv.language).toBe("hi");
  });

  it("marks the pending messages answered", async () => {
    const r = await fallbackFor("Surat");
    const rows = await getDb().select().from(messages).where(eq(messages.conversationId, r.conv.id));
    expect(rows.filter((m) => m.role === "user").every((m) => m.answeredTurnId === r.turn.id)).toBe(true);
  });
});
