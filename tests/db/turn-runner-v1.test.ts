import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq, asc } from "drizzle-orm";
import { resetDb, createConversation } from "../helpers/db";
import { seedDirectory } from "../helpers/fixtures";
import { getDb, getSql } from "@/server/db/client";
import { conversations, messages, turns } from "@/server/db/schema";
import { storeReporterMessage } from "@/server/inbound/store";
import { setFetchForTests } from "@/server/interakt/client";
import { menuText, welcomeText } from "@/server/messages/welcome";
import { runTurn } from "@/server/worker/turn-runner";
import { getBoss, stopBoss, TURN_QUEUE } from "@/server/queue/boss";

async function conv(language: "en" | "hi" | "mr" | "gu" | null = null) {
  return createConversation({ isTest: true, phone: `+91TEST_${Math.random().toString(36).slice(2, 9)}`, language });
}
const assistant = async (id: string) =>
  (await getDb().select().from(messages).where(eq(messages.conversationId, id)).orderBy(asc(messages.createdAt))).filter((m) => m.role === "assistant");

describe("runTurn v1", () => {
  beforeEach(async () => { await stopBoss(); await resetDb(); await seedDirectory(); });
  afterEach(async () => { await stopBoss(); });

  it("is a no-op without pending messages", async () => {
    const c = await conv();
    expect((await runTurn(c.id)).kind).toBe("noop");
  });

  it("sends exactly one welcome for a greeting burst and marks all answered", async () => {
    const c = await conv();
    await storeReporterMessage(c.id, { kind: "text", content: "hi" });
    await storeReporterMessage(c.id, { kind: "text", content: "hello" });
    expect((await runTurn(c.id)).kind).toBe("welcome");
    const out = await assistant(c.id);
    expect(out).toHaveLength(1);
    expect(out[0].content).toContain("Arham Always Care");
    const [row] = await getDb().select().from(conversations).where(eq(conversations.id, c.id));
    expect(row.welcomedAt).not.toBeNull();
    expect(row.language).toBe("en");
    expect((await runTurn(c.id)).kind).toBe("noop");
  });

  it("welcomes then answers a real first message in the same job", async () => {
    const c = await conv();
    await storeReporterMessage(c.id, { kind: "text", content: "dog injured near ghatkopar station" });
    const r = await runTurn(c.id);
    expect(r.kind).toBe("fallback");
    const out = await assistant(c.id);
    expect(out).toHaveLength(2);
    expect(out[0].content).toContain("Arham Always Care");
    expect(out[1].content).toContain("+91 70000 00001");
  });

  it("re-sends the menu for the menu keyword", async () => {
    const c = await conv();
    await storeReporterMessage(c.id, { kind: "text", content: "hi" });
    await runTurn(c.id);
    await storeReporterMessage(c.id, { kind: "text", content: "menu" });
    expect((await runTurn(c.id)).kind).toBe("menu");
    const out = await assistant(c.id);
    expect(out[1].kind).toBe("interactive");
  });

  it("answers an audio-only burst with the please-type line in Hindi", async () => {
    const c = await conv("hi");
    await getDb().update(conversations).set({ welcomedAt: new Date() }).where(eq(conversations.id, c.id));
    await storeReporterMessage(c.id, { kind: "audio", content: "", mediaUrl: "https://x/a.ogg" });
    expect((await runTurn(c.id)).kind).toBe("audio_only");
    const out = await assistant(c.id);
    expect(out[0].content).toContain("वॉइस नोट");
    expect(out[0].origin).toBe("system");
  });

  it("stays silent in human mode and leaves messages pending", async () => {
    const c = await conv();
    await getDb().update(conversations).set({ mode: "human", welcomedAt: new Date() }).where(eq(conversations.id, c.id));
    await storeReporterMessage(c.id, { kind: "text", content: "hello?" });
    expect((await runTurn(c.id)).kind).toBe("human_mode");
    expect(await assistant(c.id)).toHaveLength(0);
    const [m] = await getDb().select().from(messages).where(eq(messages.conversationId, c.id));
    expect(m.answeredTurnId).toBeNull();
  });

  it("records a turn row for every answered burst", async () => {
    const c = await conv();
    await getDb().update(conversations).set({ welcomedAt: new Date() }).where(eq(conversations.id, c.id));
    await storeReporterMessage(c.id, { kind: "text", content: "Surat" });
    await runTurn(c.id);
    const t = await getDb().select().from(turns).where(eq(turns.conversationId, c.id));
    expect(t).toHaveLength(1);
    expect(t[0].status).toBe("fallback");
  });

  it("sends the welcome and the menu as lists in the reporter's language, section title included", async () => {
    const c = await createConversation({ phone: "+919876500999" });
    const actions: { button: string; sections: { title: string }[] }[] = [];
    setFetchForTests((async (_url: string | URL | Request, init?: RequestInit) => {
      actions.push(JSON.parse(String(init!.body)).data.message.action);
      return new Response(JSON.stringify({ id: `wa-${actions.length}` }), { status: 201 });
    }) as typeof fetch);
    try {
      await storeReporterMessage(c.id, { kind: "text", content: "नमस्ते" });
      expect((await runTurn(c.id)).kind).toBe("welcome");
      await storeReporterMessage(c.id, { kind: "text", content: "मेनू" });
      expect((await runTurn(c.id)).kind).toBe("menu");
    } finally {
      setFetchForTests(null);
    }
    expect(actions.map((a) => [a.button, a.sections.map((s) => s.title)])).toEqual([
      ["विकल्प", ["एक विकल्प चुनें"]],
      ["विकल्प", ["एक विकल्प चुनें"]],
    ]);
    const out = await assistant(c.id);
    expect(out.map((m) => [m.kind, m.content])).toEqual([
      ["interactive", welcomeText("hi")],
      ["interactive", menuText("hi")],
    ]);
  });

  it("requeues with a delay, answering nothing, while another worker holds the conversation lock", async () => {
    const c = await conv();
    await storeReporterMessage(c.id, { kind: "text", content: "hi" });
    const holder = await getSql().reserve();
    try {
      await holder`select pg_advisory_lock(hashtext(${c.id})::bigint)`;
      expect(await runTurn(c.id)).toEqual({ kind: "locked", requeued: true });
    } finally {
      await holder`select pg_advisory_unlock(hashtext(${c.id})::bigint)`;
      holder.release();
    }
    expect(await assistant(c.id)).toHaveLength(0);
    const jobs = await (await getBoss()).findJobs(TURN_QUEUE, { key: c.id });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].startAfter.getTime() - jobs[0].createdOn.getTime()).toBeGreaterThanOrEqual(1000);
    expect((await runTurn(c.id)).kind).toBe("welcome");
  });
});
