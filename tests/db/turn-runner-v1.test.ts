import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq, asc } from "drizzle-orm";
import { resetDb, createConversation } from "../helpers/db";
import { seedDirectory } from "../helpers/fixtures";
import { closeDb, getDb, getSql } from "@/server/db/client";
import * as dbClient from "@/server/db/client";
import { getConfig, resetConfigForTests } from "@/server/config";
import { conversations, messages, turns } from "@/server/db/schema";
import { storeReporterMessage } from "@/server/inbound/store";
import { setFetchForTests } from "@/server/interakt/client";
import { log } from "@/server/log";
import { menuText, welcomeText } from "@/server/messages/welcome";
import { claimWelcome } from "@/server/worker/first-contact";
import { runTurn } from "@/server/worker/turn-runner";
import { getBoss, stopBoss, TURN_QUEUE } from "@/server/queue/boss";
import { FakeBackend, okReply } from "@/server/agent/fake-backend";
import { findAmbulancesImpl } from "@/server/agent/tools";
import type { TurnInput } from "@/server/agent/types";

async function conv(language: "en" | "hi" | "mr" | "gu" | null = null) {
  return createConversation({ isTest: true, phone: `+91TEST_${Math.random().toString(36).slice(2, 9)}`, language });
}
const assistant = async (id: string) =>
  (await getDb().select().from(messages).where(eq(messages.conversationId, id)).orderBy(asc(messages.createdAt))).filter((m) => m.role === "assistant");
const byContent = async (content: string) => (await getDb().select().from(messages).where(eq(messages.content, content)))[0];

/** Stubs Interakt so that `during` runs once, while the turn's first send is in flight. */
function duringFirstSend(during: () => Promise<void>) {
  let ran = false;
  setFetchForTests((async () => {
    if (!ran) {
      ran = true;
      await during();
    }
    return new Response(JSON.stringify({ id: `wa-${Math.random().toString(36).slice(2, 9)}` }), { status: 201 });
  }) as typeof fetch);
}

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
    expect(row.language).toBeNull();
    expect((await runTurn(c.id)).kind).toBe("noop");
  });

  it("welcomes then answers a real first message in the same job", async () => {
    const c = await conv();
    await storeReporterMessage(c.id, { kind: "text", content: "dog injured near ghatkopar station" });
    const r = await runTurn(c.id, { backend: new FakeBackend([okReply({ reply: "Ghatkopar ke liye: {{PHONE:helpline}}", intent: "ambulance" })]) });
    expect(r.kind).toBe("ok");
    const out = await assistant(c.id);
    expect(out).toHaveLength(2);
    expect(out[0].content).toContain("Arham Always Care");
    expect(out[1].content).toContain("+91 99999 00000");
  });

  it("sends a bare greeting after the welcome to the model, which answers it, never the menu", async () => {
    const c = await conv();
    await getDb().update(conversations).set({ welcomedAt: new Date() }).where(eq(conversations.id, c.id));
    await storeReporterMessage(c.id, { kind: "text", content: "hi" });
    const backend = new FakeBackend([okReply({ reply: "Hello! How can we help you today?", intent: "smalltalk" })]);
    const r = await runTurn(c.id, { backend });
    expect(r.kind).toBe("ok");
    expect(backend.calls).toHaveLength(1);
    expect(backend.calls[0].prompt).not.toContain("The welcome menu was just sent");
    expect((await assistant(c.id)).map((m) => [m.kind, m.origin, m.content])).toEqual([["text", "agent", "Hello! How can we help you today?"]]);
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

  it("links the welcome, the menu and the voice-note line to the system turns that sent them", async () => {
    const c = await conv();
    await storeReporterMessage(c.id, { kind: "text", content: "hi" });
    const welcome = await runTurn(c.id);
    await storeReporterMessage(c.id, { kind: "text", content: "menu" });
    const menu = await runTurn(c.id);
    await storeReporterMessage(c.id, { kind: "audio", content: "", mediaUrl: "https://x/a.ogg" });
    const audio = await runTurn(c.id);
    expect([welcome.kind, menu.kind, audio.kind]).toEqual(["welcome", "menu", "audio_only"]);
    expect((await assistant(c.id)).map((m) => m.turnId)).toEqual([welcome.turnId, menu.turnId, audio.turnId]);
    const rows = await getDb().select().from(turns).where(eq(turns.conversationId, c.id)).orderBy(asc(turns.createdAt));
    expect(rows.map((t) => [t.id, t.model, t.status, t.error])).toEqual([
      [welcome.turnId, "system:welcome", "ok", null],
      [menu.turnId, "system:menu", "ok", null],
      [audio.turnId, "system:audio", "ok", null],
    ]);
  });

  it("marks a system turn failed when its reply was not delivered, and still answers the burst", async () => {
    setFetchForTests((async () => new Response(JSON.stringify({ message: "rejected" }), { status: 400 })) as typeof fetch);
    try {
      const c = await createConversation({ phone: "+919876500994" });
      await storeReporterMessage(c.id, { kind: "text", content: "hi" });
      const welcome = await runTurn(c.id);
      await storeReporterMessage(c.id, { kind: "text", content: "menu" });
      const menu = await runTurn(c.id);
      expect([welcome.kind, menu.kind]).toEqual(["welcome", "menu"]);
      const rows = await getDb().select().from(turns).where(eq(turns.conversationId, c.id)).orderBy(asc(turns.createdAt));
      expect(rows.map((t) => [t.id, t.status, t.error])).toEqual([
        [welcome.turnId, "failed", "delivery_failed"],
        [menu.turnId, "failed", "delivery_failed"],
      ]);
      expect((await byContent("hi")).answeredTurnId).toBe(welcome.turnId);
      expect((await byContent("menu")).answeredTurnId).toBe(menu.turnId);
      expect((await assistant(c.id)).map((m) => [m.deliveryStatus, m.turnId])).toEqual([
        ["failed", welcome.turnId],
        ["failed", menu.turnId],
      ]);
    } finally {
      setFetchForTests(null);
    }
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
    await runTurn(c.id, { backend: new FakeBackend([okReply({ reply: "Which area of Surat are you in?", intent: "ambulance" })]) });
    const t = await getDb().select().from(turns).where(eq(turns.conversationId, c.id));
    expect(t).toHaveLength(1);
    expect(t[0].status).toBe("ok");
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

  it.each([
    ["a bare greeting", { kind: "text", content: "hi" }, "welcome"],
    ["a voice note", { kind: "audio", content: "", mediaUrl: "https://x/a.ogg" }, "audio_only"],
  ] as const)("leaves the language unset after %s, so the first real message decides it", async (_first, message, firstKind) => {
    const c = await conv();
    const language = async () => (await getDb().select().from(conversations).where(eq(conversations.id, c.id)))[0].language;
    await storeReporterMessage(c.id, message);
    expect((await runTurn(c.id)).kind).toBe(firstKind);
    expect(await language()).toBeNull();
    await storeReporterMessage(c.id, { kind: "text", content: "घाटकोपर में कुत्ता घायल है" });
    const backend = new FakeBackend([async (input: TurnInput) => {
      const found = await findAmbulancesImpl(input.toolContext!, { city: "Mumbai", area: "Ghatkopar", query: "घाटकोपर" });
      return okReply({ reply: `घाटकोपर की एम्बुलेंस का नंबर: {{AMB:${found.candidates[0].handle}}}`, language: "hi", intent: "ambulance" });
    }]);
    expect((await runTurn(c.id, { backend })).kind).toBe("ok");
    const reply = (await assistant(c.id)).at(-1)!.content;
    expect(reply).toBe("घाटकोपर की एम्बुलेंस का नंबर: +91 70000 00001");
    expect(await language()).toBe("hi");
  });

  it("returns the turn's outcome, releasing the lock, when the advisory unlock query fails", async () => {
    const c = await conv();
    await getDb().update(conversations).set({ welcomedAt: new Date() }).where(eq(conversations.id, c.id));
    await storeReporterMessage(c.id, { kind: "text", content: "Surat" });
    const open = dbClient.openLockConnection;
    vi.spyOn(dbClient, "openLockConnection").mockImplementationOnce(() => {
      const conn = open();
      // Runs the real unlock, then fails the way a connection lost mid-query does.
      const unlockFails = async (strings: TemplateStringsArray, ...values: never[]) => {
        const rows = await conn(strings, ...values);
        if (strings.join("").includes("pg_advisory_unlock")) throw new Error("connection lost while unlocking");
        return rows;
      };
      return Object.assign(unlockFails, { end: conn.end }) as unknown as typeof conn;
    });
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    try {
      expect((await runTurn(c.id)).kind).toBe("ok");
      expect(warn).toHaveBeenCalledWith({ conversationId: c.id }, "advisory unlock failed");
    } finally {
      vi.restoreAllMocks();
    }
    await storeReporterMessage(c.id, { kind: "text", content: "Surat" });
    expect((await runTurn(c.id)).kind).toBe("ok"); // not "locked"
  });

  it("returns the turn's outcome, without crashing, when the lock connection's backend dies mid-turn", async () => {
    const c = await createConversation({ phone: "+919876500996", welcomedAt: new Date() });
    await storeReporterMessage(c.id, { kind: "text", content: "Surat" });
    let terminated = false;
    duringFirstSend(async () => {
      // pg_locks keeps a bigint advisory key as classid (high 32 bits) and objid (low 32 bits).
      const [lock] = await getSql()<{ pid: number }[]>`
        select pid from pg_locks
        where locktype = 'advisory' and granted and objsubid = 1
          and ((classid::bigint << 32) | objid::bigint) = hashtext(${c.id})::bigint`;
      const [row] = await getSql()<{ terminated: boolean }[]>`select pg_terminate_backend(${lock.pid}) as terminated`;
      terminated = row.terminated;
      await new Promise((r) => setTimeout(r, 200)); // the lock connection sees its socket close before the turn ends
    });
    const uncaught: unknown[] = [];
    const onUncaught = (err: unknown) => void uncaught.push(err);
    process.on("uncaughtException", onUncaught);
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const stuck = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`the turn did not return within 10 s; uncaught: ${uncaught.map(String).join(" | ") || "none"}`)), 10_000);
      });
      const r = await Promise.race([runTurn(c.id), stuck]);
      expect(r.kind).toBe("ok");
      expect((await byContent("Surat")).answeredTurnId).toBe(r.turnId);
      expect(warn).toHaveBeenCalledWith({ conversationId: c.id }, "advisory lock lost mid-turn");
    } finally {
      clearTimeout(timer);
      process.off("uncaughtException", onUncaught);
      setFetchForTests(null);
      vi.restoreAllMocks();
    }
    expect(terminated).toBe(true);
    expect(uncaught).toEqual([]);
    expect((await runTurn(c.id)).kind).toBe("noop"); // not "locked": the lock went with the dead session
  }, 30_000);

  it("requeues at once for a message that arrives mid-turn and leaves it pending for that turn", async () => {
    const c = await createConversation({ phone: "+919876500998", welcomedAt: new Date() });
    await storeReporterMessage(c.id, { kind: "text", content: "Surat" });
    duringFirstSend(async () => {
      await storeReporterMessage(c.id, { kind: "text", content: "and a cat too" });
    });
    const r = await runTurn(c.id).finally(() => setFetchForTests(null));
    expect(r).toMatchObject({ kind: "ok", requeued: true });
    const jobs = await (await getBoss()).findJobs(TURN_QUEUE, { key: c.id });
    expect(jobs).toHaveLength(1);
    expect(Math.abs(jobs[0].startAfter.getTime() - jobs[0].createdOn.getTime())).toBeLessThan(1000);
    expect((await byContent("Surat")).answeredTurnId).toBe(r.turnId);
    expect((await byContent("and a cat too")).answeredTurnId).toBeNull();
  });

  it("does not requeue when the conversation is taken over mid-turn, leaving the new message pending", async () => {
    const c = await createConversation({ phone: "+919876500997", welcomedAt: new Date() });
    await storeReporterMessage(c.id, { kind: "text", content: "Surat" });
    duringFirstSend(async () => {
      await storeReporterMessage(c.id, { kind: "text", content: "and a cat too" });
      await getDb().update(conversations).set({ mode: "human" }).where(eq(conversations.id, c.id));
    });
    const r = await runTurn(c.id).finally(() => setFetchForTests(null));
    expect(r).toMatchObject({ kind: "ok", requeued: false });
    expect((await byContent("and a cat too")).answeredTurnId).toBeNull();
    expect(await (await getBoss()).findJobs(TURN_QUEUE, { key: c.id })).toHaveLength(0);
  });

  it("lets exactly one of two concurrent first-contact claims win", async () => {
    const c = await conv();
    const claims = await Promise.all([claimWelcome(c.id), claimWelcome(c.id)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await claimWelcome(c.id)).toBe(false);
  });

  it("finishes a full worker's worth of concurrent turns without exhausting the connection pool", async () => {
    // Turns once held a pooled connection each for their advisory lock, and at the highest allowed
    // concurrency a fixed pool of 8 hung every turn. The lock now has a connection of its own; this
    // keeps a full worker's worth of concurrent turns finishing.
    const configured = process.env.WORKER_CONCURRENCY;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      process.env.WORKER_CONCURRENCY = "8";
      resetConfigForTests();
      await closeDb(); // the next query builds a pool sized for this concurrency
      const n = getConfig().workerConcurrency;
      const ids: string[] = [];
      for (let i = 0; i < n; i++) {
        const c = await createConversation({ isTest: true, phone: `+91TEST_pool${i}`, welcomedAt: new Date() });
        await storeReporterMessage(c.id, { kind: "text", content: "Surat" });
        ids.push(c.id);
      }
      const hung = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${n} concurrent turns did not finish within 15 s`)), 15_000);
      });
      const outcomes = await Promise.race([Promise.all(ids.map((id) => runTurn(id))), hung]);
      expect(outcomes.map((o) => o.kind)).toEqual(Array(n).fill("ok"));
    } finally {
      clearTimeout(timer);
      if (configured === undefined) delete process.env.WORKER_CONCURRENCY;
      else process.env.WORKER_CONCURRENCY = configured;
      resetConfigForTests();
      await closeDb();
    }
  }, 30_000);
});
