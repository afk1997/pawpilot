import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { inspect } from "node:util";
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
import { runWorkerProcess, startWorker, sweepUnanswered } from "@/server/worker/start";
import * as turnRunner from "@/server/worker/turn-runner";
import { getWorkerState } from "@/server/worker/pause";
import { createTurn } from "@/server/worker/persist";

/** A welcomed test conversation with one reporter message, backdated `ageSeconds` on the database clock. */
async function withPendingMessage(phone: string, ageSeconds: number, mode: "agent" | "human" = "agent") {
  const c = await createConversation({ isTest: true, phone, mode, welcomedAt: new Date() });
  const { id } = await storeReporterMessage(c.id, { kind: "text", content: "Surat" });
  await getDb().update(messages).set({ createdAt: sql`now() - make_interval(secs => ${ageSeconds})` }).where(eq(messages.id, id!));
  return c;
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
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

  it("sweepUnanswered leaves a reporter message older than 6 hours alone", async () => {
    const ancient = await withPendingMessage("+91TEST_sweep_ancient", 7 * 60 * 60);
    expect(await sweepUnanswered()).toBe(0);
    expect(await (await getBoss()).findJobs(TURN_QUEUE, { key: ancient.id })).toHaveLength(0);
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

  it("logs a failed turn with only its class and code, then rethrows so pg-boss retries it", async () => {
    const c = await createConversation({ isTest: true, phone: "+91TEST_turn_failed" });
    const failing = vi.spyOn(turnRunner, "runTurn").mockRejectedValue(new Error("insert failed for reporter +919876543210"));
    const worker = await startWorker({ concurrency: 1 });
    // After startWorker, whose log.level assignment replaces pino's level methods.
    const spies = (["fatal", "error", "warn", "info", "debug", "trace"] as const).map((level) => vi.spyOn(log, level));
    const error = spies[1];
    try {
      await enqueueTurn(c.id, { immediate: true });
      const boss = await getBoss();
      await waitFor(async () => (await boss.findJobs(TURN_QUEUE, { key: c.id }))[0]?.state === "retry");
      expect(error).toHaveBeenCalledWith({ conversationId: c.id, errorClass: "Error" }, "turn failed");
      const logged = spies.flatMap((spy) => spy.mock.calls).map((args) => inspect(args, { depth: null }));
      expect(logged.join("\n")).not.toContain("9876543210");
    } finally {
      await worker.stop();
      for (const spy of spies) spy.mockRestore();
      failing.mockRestore();
    }
  });

  it("warns when a turn finds its conversation locked, besides the turn-done line", async () => {
    const c = await createConversation({ isTest: true, phone: "+91TEST_turn_locked" });
    const locked = vi.spyOn(turnRunner, "runTurn").mockResolvedValue({ kind: "locked", requeued: true });
    const worker = await startWorker({ concurrency: 1 });
    const warn = vi.spyOn(log, "warn"); // after startWorker (see above)
    const info = vi.spyOn(log, "info");
    try {
      await enqueueTurn(c.id, { immediate: true });
      await waitFor(() => info.mock.calls.some(([, msg]) => msg === "turn done"));
      expect(warn).toHaveBeenCalledWith({ conversationId: c.id }, "conversation lock busy; turn requeued");
      expect(info).toHaveBeenCalledWith(expect.objectContaining({ conversationId: c.id, outcome: "locked" }), "turn done");
    } finally {
      await worker.stop();
      warn.mockRestore();
      info.mockRestore();
      locked.mockRestore();
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

  it("runs the shutdown once when a second stop signal arrives", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const signals = ["SIGTERM", "SIGINT"] as const;
    const before = new Map(signals.map((s) => [s, process.listeners(s)]));
    const added = (s: (typeof signals)[number]) => process.listeners(s).filter((l) => !before.get(s)!.includes(l));
    try {
      await runWorkerProcess();
      const info = vi.spyOn(log, "info"); // after startWorker's log.level assignment
      // Called directly rather than through process.emit, so no other listener in the test process runs.
      for (const l of added("SIGTERM")) l("SIGTERM");
      for (const l of added("SIGINT")) l("SIGINT");
      await waitFor(() => exit.mock.calls.length > 0);
      await new Promise((r) => setTimeout(r, 200)); // room for a second shutdown to finish, were there one
      expect(info.mock.calls.filter(([, msg]) => msg === "worker shutting down")).toEqual([[{ signal: "SIGTERM" }, "worker shutting down"]]);
      expect(exit).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      for (const s of signals) for (const l of added(s)) process.off(s, l);
      vi.restoreAllMocks();
    }
  });
});
