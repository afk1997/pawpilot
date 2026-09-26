import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { inspect } from "node:util";
import { and, eq, sql } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { resetDb, createConversation } from "../helpers/db";
import { seedDirectory } from "../helpers/fixtures";
import { getDb } from "@/server/db/client";
import * as dbClient from "@/server/db/client";
import { conversations, events, messages } from "@/server/db/schema";
import { getConfig, resetConfigForTests } from "@/server/config";
import { log } from "@/server/log";
import { storeReporterMessage } from "@/server/inbound/store";
import { enqueueTurn, getBoss, stopBoss, TURN_QUEUE } from "@/server/queue/boss";
import { GRACEFUL_STOP_MS, runWorkerProcess, startWorker, sweepUnanswered } from "@/server/worker/start";
import { TURN_BUDGET_MS } from "@/server/worker/claude-turn";
import { SEND_TIMEOUT_MS, setFetchForTests } from "@/server/interakt/client";
import * as turnRunner from "@/server/worker/turn-runner";
import { getWorkerState } from "@/server/worker/pause";
import { createTurn } from "@/server/worker/persist";
import * as persist from "@/server/worker/persist";

/** A reporter message on the conversation, backdated `ageSeconds` on the database clock. */
async function addPendingMessage(conversationId: string, ageSeconds: number) {
  const { id } = await storeReporterMessage(conversationId, { kind: "text", content: "Surat" });
  await getDb().update(messages).set({ createdAt: sql`now() - make_interval(secs => ${ageSeconds})` }).where(eq(messages.id, id!));
}

/** A welcomed test conversation with one reporter message, backdated `ageSeconds` on the database clock. */
async function withPendingMessage(phone: string, ageSeconds: number, mode: "agent" | "human" = "agent") {
  const c = await createConversation({ isTest: true, phone, mode, welcomedAt: new Date() });
  await addPendingMessage(c.id, ageSeconds);
  return c;
}

/** `count` turn_failed events for the conversation, `ageSeconds` old on the database clock. */
async function recordTurnFailures(conversationId: string, count: number, ageSeconds = 0) {
  await getDb()
    .insert(events)
    .values(
      Array.from({ length: count }, () => ({
        conversationId, kind: "turn_failed", payload: { errorClass: "Error" }, createdAt: sql`now() - make_interval(secs => ${ageSeconds})`,
      }))
    );
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Spies on every pino level. Call it after startWorker, whose log.level assignment replaces pino's level methods. */
function spyOnEveryLevel() {
  const spies = (["fatal", "error", "warn", "info", "debug", "trace"] as const).map((level) => vi.spyOn(log, level));
  return {
    error: spies[1],
    info: spies[3],
    /** Every call, rendered by util.inspect, which prints an Error's message and stack where JSON.stringify prints {}. */
    rendered: () => spies.flatMap((spy) => spy.mock.calls).map((args) => inspect(args, { depth: null })).join("\n"),
  };
}

/** The SIGTERM and SIGINT listeners registered after this call, and a way to remove only those. */
function signalListenersAdded() {
  const signals = ["SIGTERM", "SIGINT"] as const;
  const before = new Map(signals.map((s) => [s, process.listeners(s)]));
  const added = (s: (typeof signals)[number]) => process.listeners(s).filter((l) => !before.get(s)!.includes(l));
  return {
    added,
    remove: () => {
      for (const s of signals) for (const l of added(s)) process.off(s, l);
    },
  };
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

  it("advances the heartbeat on its interval after the startup beat", async () => {
    const worker = await startWorker({ concurrency: 1, heartbeatMs: 200 });
    try {
      const first = (await getWorkerState()).lastHeartbeatAt;
      expect(first).not.toBeNull();
      await new Promise((r) => setTimeout(r, 500));
      const later = (await getWorkerState()).lastHeartbeatAt;
      expect(later!.getTime()).toBeGreaterThan(first!.getTime());
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

  it("sweepUnanswered flags rather than re-runs a conversation with 3 failed turns in the last hour", async () => {
    const failing = await withPendingMessage("+91TEST_sweep_failing", 30);
    const flaky = await withPendingMessage("+91TEST_sweep_flaky", 30);
    const recovered = await withPendingMessage("+91TEST_sweep_recovered", 30);
    await addPendingMessage(flaky.id, 40); // two pending messages must not double-count its two failures
    await recordTurnFailures(failing.id, 3);
    await recordTurnFailures(flaky.id, 2);
    await recordTurnFailures(recovered.id, 3, 2 * 60 * 60); // outside the hour
    const warn = vi.spyOn(log, "warn");
    try {
      expect(await sweepUnanswered()).toBe(2);
      const boss = await getBoss();
      expect(await boss.findJobs(TURN_QUEUE, { key: failing.id })).toHaveLength(0);
      expect(await boss.findJobs(TURN_QUEUE, { key: flaky.id })).toHaveLength(1);
      expect(await boss.findJobs(TURN_QUEUE, { key: recovered.id })).toHaveLength(1);
      const flags = await getDb().select({ id: conversations.id, flagged: conversations.flagged, flagReason: conversations.flagReason }).from(conversations);
      expect(flags.find((r) => r.id === failing.id)).toMatchObject({ flagged: true, flagReason: "turn_failed" });
      expect(flags.find((r) => r.id === flaky.id)).toMatchObject({ flagged: false });
      expect(flags.find((r) => r.id === recovered.id)).toMatchObject({ flagged: false });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith({ conversationId: failing.id }, expect.any(String));
      // Flagged now: the next sweep neither re-runs it nor warns again.
      await sweepUnanswered();
      expect(await boss.findJobs(TURN_QUEUE, { key: failing.id })).toHaveLength(0);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("sweepUnanswered still enqueues the rest of the tick when a flag write fails", async () => {
    // Longest-waiting first, so both capped conversations come before the healthy one.
    const cappedA = await withPendingMessage("+91TEST_sweep_capped_a", 90);
    const cappedB = await withPendingMessage("+91TEST_sweep_capped_b", 60);
    const healthy = await withPendingMessage("+91TEST_sweep_healthy", 30);
    await recordTurnFailures(cappedA.id, 3);
    await recordTurnFailures(cappedB.id, 3);
    const flag = vi.spyOn(persist, "flagConversation").mockRejectedValueOnce(new Error("flag write failed for +919876543210"));
    const warn = vi.spyOn(log, "warn");
    try {
      expect(await sweepUnanswered()).toBe(1);
      const boss = await getBoss();
      expect(await boss.findJobs(TURN_QUEUE, { key: healthy.id })).toHaveLength(1);
      expect(await boss.findJobs(TURN_QUEUE, { key: cappedA.id })).toHaveLength(0);
      expect(await boss.findJobs(TURN_QUEUE, { key: cappedB.id })).toHaveLength(0);
      expect(flag).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledWith({ conversationId: cappedA.id }, "turn_failed flag not recorded");
      expect(inspect(warn.mock.calls, { depth: null })).not.toContain("9876543210");
      const flags = await getDb().select({ id: conversations.id, flagged: conversations.flagged, flagReason: conversations.flagReason }).from(conversations);
      expect(flags.find((r) => r.id === cappedA.id)).toMatchObject({ flagged: false });
      expect(flags.find((r) => r.id === cappedB.id)).toMatchObject({ flagged: true, flagReason: "turn_failed" });
    } finally {
      flag.mockRestore();
      warn.mockRestore();
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

  it("resends a failed reply through the sweep, from the stored text", async () => {
    const c = await createConversation({ phone: "+919876500995", welcomedAt: new Date() });
    const [row] = await getDb()
      .insert(messages)
      .values({
        conversationId: c.id, role: "assistant", origin: "agent", content: "Call +91 70000 00001 now.", deliveryStatus: "failed",
        deliveryHttpStatus: 502, createdAt: sql`now() - interval '1 minute'`,
      })
      .returning();
    const bodies: string[] = [];
    setFetchForTests((async (_url: unknown, init?: { body?: unknown }) => {
      bodies.push(String(init?.body));
      return new Response(JSON.stringify({ id: "wa-resent" }), { status: 201 });
    }) as typeof fetch);
    const worker = await startWorker({ concurrency: 1, sweepMs: 100 });
    try {
      const stored = async () => (await getDb().select().from(messages).where(eq(messages.id, row.id)))[0];
      await waitFor(async () => (await stored()).deliveryStatus === "sent");
      expect(await stored()).toMatchObject({ deliveryAttempts: 2, providerMessageId: "out:wa-resent" });
      expect(bodies.map((b) => JSON.parse(b).data.message)).toEqual(["Call +91 70000 00001 now."]);
    } finally {
      await worker.stop();
      setFetchForTests(null);
    }
  });

  it("logs a failed sweep with only a fixed message, the error code and its class", async () => {
    class QueryFailed extends Error {}
    const failing = vi.spyOn(getDb(), "select").mockImplementation(() => {
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
    vi.spyOn(turnRunner, "runTurn").mockRejectedValue(new Error("insert failed for reporter +919876543210"));
    const worker = await startWorker({ concurrency: 1 });
    const logs = spyOnEveryLevel();
    try {
      await enqueueTurn(c.id, { immediate: true });
      const boss = await getBoss();
      await waitFor(async () => (await boss.findJobs(TURN_QUEUE, { key: c.id }))[0]?.state === "retry");
      expect(logs.error).toHaveBeenCalledWith({ conversationId: c.id, errorClass: "Error" }, "turn failed");
      expect(logs.rendered()).not.toContain("9876543210");
      const failures = await getDb().select().from(events).where(and(eq(events.conversationId, c.id), eq(events.kind, "turn_failed")));
      expect(failures).toHaveLength(1);
      expect(failures[0].payload).toMatchObject({ errorClass: "Error" });
      expect(JSON.stringify(failures[0].payload)).not.toMatch(/\d/);
    } finally {
      await worker.stop();
      vi.restoreAllMocks();
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

  it("gives an in-flight turn its whole budget, a send and a margin to finish on stop: 145 s", () => {
    expect(GRACEFUL_STOP_MS).toBe(TURN_BUDGET_MS + SEND_TIMEOUT_MS + 30_000);
    expect(GRACEFUL_STOP_MS).toBe(145_000);
  });

  it("caps concurrency at WORKER_CONCURRENCY, takes LOG_LEVEL from config and passes the graceful stop window to pg-boss", async () => {
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
      expect(stop).toHaveBeenCalledWith({ graceful: true, timeout: GRACEFUL_STOP_MS });
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
    const listeners = signalListenersAdded();
    try {
      await runWorkerProcess();
      const info = vi.spyOn(log, "info"); // after startWorker's log.level assignment
      // Called directly rather than through process.emit, so no other listener in the test process runs.
      for (const l of listeners.added("SIGTERM")) l("SIGTERM");
      for (const l of listeners.added("SIGINT")) l("SIGINT");
      await waitFor(() => exit.mock.calls.length > 0);
      await new Promise((r) => setTimeout(r, 200)); // room for a second shutdown to finish, were there one
      expect(info.mock.calls.filter(([, msg]) => msg === "worker shutting down")).toEqual([[{ signal: "SIGTERM" }, "worker shutting down"]]);
      expect(exit).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      listeners.remove();
      vi.restoreAllMocks();
    }
  });

  it("closes the database and logs the end of shutdown, with data-free fields, when the graceful stop fails", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    vi.spyOn(PgBoss.prototype, "stop").mockRejectedValueOnce(new Error("stop failed near +919876543210"));
    const closeDb = vi.spyOn(dbClient, "closeDb");
    const listeners = signalListenersAdded();
    try {
      await runWorkerProcess();
      const logs = spyOnEveryLevel();
      for (const l of listeners.added("SIGTERM")) l("SIGTERM");
      await waitFor(() => exit.mock.calls.length > 0);
      expect(logs.error).toHaveBeenCalledWith({ errorClass: "Error" }, "worker stop failed");
      expect(closeDb).toHaveBeenCalledTimes(1);
      expect(logs.info).toHaveBeenCalledWith(expect.objectContaining({ signal: "SIGTERM" }), "worker stopped");
      expect(exit).toHaveBeenCalledWith(1);
      expect(logs.rendered()).not.toContain("9876543210");
    } finally {
      listeners.remove();
      vi.restoreAllMocks(); // the real stop() runs again, so afterEach's stopBoss() stops this instance
    }
  });
});
