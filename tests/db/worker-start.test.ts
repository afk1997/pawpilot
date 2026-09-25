import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { resetDb, createConversation } from "../helpers/db";
import { seedDirectory } from "../helpers/fixtures";
import { getDb } from "@/server/db/client";
import { conversations, messages } from "@/server/db/schema";
import { getConfig, resetConfigForTests } from "@/server/config";
import { log } from "@/server/log";
import { storeReporterMessage } from "@/server/inbound/store";
import { enqueueTurn, getBoss, stopBoss, TURN_QUEUE } from "@/server/queue/boss";
import { startWorker, sweepUnanswered } from "@/server/worker/start";
import { getWorkerState } from "@/server/worker/pause";
import { createTurn } from "@/server/worker/persist";

/** A welcomed test conversation with one reporter message, backdated `ageSeconds` on the database clock. */
async function withPendingMessage(phone: string, ageSeconds: number, mode: "agent" | "human" = "agent") {
  const c = await createConversation({ isTest: true, phone, mode, welcomedAt: new Date() });
  const { id } = await storeReporterMessage(c.id, { kind: "text", content: "Surat" });
  await getDb().update(messages).set({ createdAt: sql`now() - make_interval(secs => ${ageSeconds})` }).where(eq(messages.id, id!));
  return c;
}

describe("startWorker", () => {
  beforeEach(async () => { await stopBoss(); await resetDb(); await seedDirectory(); });
  afterEach(async () => { await stopBoss(); });

  it("processes a queued turn end to end and heartbeats", async () => {
    const c = await createConversation({ isTest: true, phone: "+91TEST_worker" });
    await getDb().update(conversations).set({ welcomedAt: new Date() }).where(eq(conversations.id, c.id));
    await storeReporterMessage(c.id, { kind: "text", content: "Surat" });
    const worker = await startWorker({ concurrency: 1, heartbeatMs: 200 });
    try {
      await enqueueTurn(c.id, { immediate: true });
      const deadline = Date.now() + 15_000;
      let out: { content: string }[] = [];
      while (Date.now() < deadline) {
        out = (await getDb().select().from(messages).where(eq(messages.conversationId, c.id))).filter((m) => m.role === "assistant");
        if (out.length > 0) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(out.length).toBeGreaterThanOrEqual(1);
      expect(out[0].content.length).toBeGreaterThan(0);
      await new Promise((r) => setTimeout(r, 400));
      expect((await getWorkerState()).lastHeartbeatAt).not.toBeNull();
    } finally {
      await worker.stop();
    }
  });

  it("sweepUnanswered enqueues only agent-mode conversations with a reporter message waiting over 15 s", async () => {
    const stale = await withPendingMessage("+91TEST_sweep_stale", 30);
    const human = await withPendingMessage("+91TEST_sweep_human", 30, "human");
    const fresh = await withPendingMessage("+91TEST_sweep_fresh", 5);
    const answered = await withPendingMessage("+91TEST_sweep_answered", 30);
    const turn = await createTurn({ conversationId: answered.id, status: "ok", model: "system:menu" });
    await getDb().update(messages).set({ answeredTurnId: turn.id }).where(eq(messages.conversationId, answered.id));
    const replied = await createConversation({ isTest: true, phone: "+91TEST_sweep_replied", welcomedAt: new Date() });
    await getDb().insert(messages).values({
      conversationId: replied.id, role: "assistant", origin: "fallback", content: "reply", createdAt: sql`now() - interval '30 seconds'`,
    });

    expect(await sweepUnanswered()).toBe(1);

    const boss = await getBoss();
    expect(await boss.findJobs(TURN_QUEUE, { key: stale.id })).toHaveLength(1);
    for (const c of [human, fresh, answered, replied]) {
      expect(await boss.findJobs(TURN_QUEUE, { key: c.id })).toHaveLength(0);
    }
  });

  it("answers a stale pending message through the sweep alone", async () => {
    const c = await withPendingMessage("+91TEST_sweep_worker", 30);
    const worker = await startWorker({ concurrency: 1, sweepMs: 300 });
    try {
      const deadline = Date.now() + 15_000;
      let out: { content: string }[] = [];
      while (Date.now() < deadline) {
        out = (await getDb().select().from(messages).where(eq(messages.conversationId, c.id))).filter((m) => m.role === "assistant");
        if (out.length > 0) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(out.length).toBeGreaterThanOrEqual(1);
      expect(out[0].content.length).toBeGreaterThan(0);
    } finally {
      await worker.stop();
    }
  });

  it("logs a failed sweep with only a fixed message, the error code and its class", async () => {
    class QueryFailed extends Error {}
    const failing = vi.spyOn(getDb(), "selectDistinct").mockImplementation(() => {
      throw new QueryFailed("Failed query ... params: +919876543210", { cause: { code: "57P01", detail: "Key (phone)=(+919876543210)" } });
    });
    const worker = await startWorker({ concurrency: 1, sweepMs: 100 });
    const warn = vi.spyOn(log, "warn"); // after startWorker, whose log.level assignment replaces pino's level methods
    try {
      const deadline = Date.now() + 5_000;
      while (warn.mock.calls.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      expect(warn).toHaveBeenCalledWith({ code: "57P01", errorClass: "QueryFailed" }, "sweep failed");
    } finally {
      await worker.stop();
      warn.mockRestore();
      failing.mockRestore();
    }
  });

  it("caps concurrency at WORKER_CONCURRENCY, takes LOG_LEVEL from config and gives in-flight turns 60 s on stop", async () => {
    const work = vi.spyOn(PgBoss.prototype, "work");
    const stop = vi.spyOn(PgBoss.prototype, "stop");
    const envLevel = process.env.LOG_LEVEL;
    const logLevel = log.level;
    try {
      process.env.LOG_LEVEL = "fatal"; // quiet, but distinct from the "silent" the logger was created with
      resetConfigForTests();
      const worker = await startWorker({ concurrency: 99 });
      await worker.stop();
      expect(work).toHaveBeenCalledWith(
        TURN_QUEUE,
        expect.objectContaining({ localConcurrency: getConfig().workerConcurrency }),
        expect.any(Function)
      );
      expect(log.level).toBe("fatal");
      expect(stop).toHaveBeenCalledWith({ graceful: true, timeout: 60_000 });
    } finally {
      work.mockRestore();
      stop.mockRestore();
      if (envLevel === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = envLevel;
      resetConfigForTests();
      log.level = logLevel;
    }
  });
});
