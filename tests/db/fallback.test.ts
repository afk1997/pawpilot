import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { resetDb, createConversation } from "../helpers/db";
import { seedDirectory } from "../helpers/fixtures";
import { getDb } from "@/server/db/client";
import { conversations, messages, turns } from "@/server/db/schema";
import { storeReporterMessage } from "@/server/inbound/store";
import { loadActiveAmbulances } from "@/server/directory/repo";
import { matchAmbulances } from "@/server/directory/matcher";
import { gatherPending } from "@/server/worker/gather";
import { runFallbackTurn } from "@/server/worker/fallback";
import { pauseClaude, isClaudePaused, clearClaudePause, heartbeat, getWorkerState } from "@/server/worker/pause";

async function fallbackFor(text: string, language: "en" | "hi" | "mr" | "gu" | null = null) {
  const c = await createConversation({ isTest: true, phone: `+91TEST_${Math.random().toString(36).slice(2, 8)}`, language });
  await storeReporterMessage(c.id, { kind: "text", content: text });
  const g = (await gatherPending(c.id))!;
  const r = await runFallbackTurn({ conversation: g.conversation, pending: g.pending, reason: "test" });
  const [conv] = await getDb().select().from(conversations).where(eq(conversations.id, c.id));
  return { ...r, conv };
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
    await pauseClaude(new Date(Date.now() - 1000), "LIMITED");
    expect(await isClaudePaused()).toBe(false);
  });
});

describe("runFallbackTurn", () => {
  beforeEach(async () => { await resetDb(); await seedDirectory(); });

  it("delivers a single card for a unique match in the reporter's language", async () => {
    const r = await fallbackFor("ghatkopar me kutta ghayal hai");
    expect(r.message.content).toContain("Arham Animal Ambulance, Ghatkopar");
    expect(r.message.content).toContain("+91 70000 00001");
    expect(r.message.content).toContain("कृपया उन्हें तुरंत कॉल करें");
    expect(r.message.origin).toBe("fallback");
    expect(r.turn.status).toBe("fallback");
    expect(r.conv.flagged).toBe(true);
    expect(r.conv.flagReason).toBe("claude_unavailable");
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
  });

  it("sends the helpline card when nothing matches", async () => {
    const r = await fallbackFor("Lucknow", "en");
    expect(r.message.content).toContain("I couldn't find that area right now.");
    expect(r.message.content).toContain("+91 99999 00000");
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
    expect(t.structuredOutput).toEqual({ matched: probe.candidates.length, matchType });
  });

  it("marks the pending messages answered", async () => {
    const r = await fallbackFor("Surat");
    const rows = await getDb().select().from(messages).where(eq(messages.conversationId, r.conv.id));
    expect(rows.filter((m) => m.role === "user").every((m) => m.answeredTurnId === r.turn.id)).toBe(true);
  });
});
