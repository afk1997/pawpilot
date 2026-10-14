import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createConversation, resetDb } from "../helpers/db";
import { getDb } from "@/server/db/client";
import { conversations, messages, workerState } from "@/server/db/schema";
import { computeHealth } from "@/server/health";
import { heartbeat, pauseClaude, recordOkTurn } from "@/server/worker/pause";
import { recordEvent, upsertConversationByPhone } from "@/server/inbound/store";
import { enqueueTurn, stopBoss } from "@/server/queue/boss";
import { resetConfigForTests } from "@/server/config";
import * as dbClient from "@/server/db/client";
import { getSql } from "@/server/db/client";
import { log } from "@/server/log";
import * as pause from "@/server/worker/pause";
import { GET } from "@/app/api/health/route";

describe("computeHealth", () => {
  beforeEach(async () => { await stopBoss(); await resetDb(); });
  afterEach(async () => { await stopBoss(); delete process.env.LLM_TOKEN_ISSUED_AT; resetConfigForTests(); });

  it("is 503 until the worker heartbeats, then 200", async () => {
    expect((await computeHealth()).status).toBe(503);
    await heartbeat();
    const h = await computeHealth();
    expect(h.status).toBe(200);
    expect(h.checks.db).toBe(true);
    expect(h.checks.workerHeartbeatAgeS).toBeLessThan(5);
  });

  it("is 503 after an auth error and reports the pause", async () => {
    await heartbeat();
    await pauseClaude(new Date(Date.now() + 60_000), "AUTH");
    await recordEvent("claude_auth_error", { message: "x" });
    const h = await computeHealth();
    expect(h.status).toBe(503);
    expect(h.checks.authErrorLastHour).toBe(true);
    expect(h.checks.pauseReason).toBe("AUTH");
  });

  it("counts token days left from the issued date", async () => {
    await heartbeat();
    process.env.LLM_TOKEN_ISSUED_AT = new Date(Date.now() - 300 * 86_400_000).toISOString().slice(0, 10);
    resetConfigForTests();
    const h = await computeHealth();
    expect(h.checks.tokenDaysLeft).toBeGreaterThanOrEqual(64);
    expect(h.checks.tokenDaysLeft).toBeLessThanOrEqual(66);
  });

  it("counts queued turn jobs from pg-boss's own table", async () => {
    await heartbeat();
    const { id } = await createConversation({ isTest: true });
    await enqueueTurn(id);
    const h = await computeHealth();
    expect(h.checks.queue?.queued).toBeGreaterThanOrEqual(1);
    expect(h.checks.queue).toMatchObject({ active: 0, failed: 0 });
  });

  it("reports no queue counts before pg-boss has created its schema, as an expected state", async () => {
    await heartbeat();
    const warned = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    try {
      const h = await computeHealth();
      expect(h.checks.queue).toBeNull();
      expect(h.status).toBe(200);
      expect(warned).not.toHaveBeenCalled();
    } finally {
      warned.mockRestore();
    }
  });

  it("reports a Claude pause only while it lasts, and a pause alone is not a failure", async () => {
    await heartbeat();
    const now = Date.now();
    const until = new Date(now + 10 * 60_000);
    await pauseClaude(until, "LIMITED");
    const paused = await computeHealth(new Date(now));
    expect(paused.status).toBe(200);
    expect(paused.checks).toMatchObject({ claudePaused: true, claudePausedUntil: until.toISOString(), pauseReason: "LIMITED" });
    const ended = await computeHealth(new Date(now + 11 * 60_000));
    expect(ended.checks).toMatchObject({ claudePaused: false, claudePausedUntil: null, pauseReason: null });
  });

  it("reports the age of the last OK turn", async () => {
    await heartbeat();
    expect((await computeHealth()).checks.lastOkTurnAgeS).toBeNull();
    await recordOkTurn();
    const age = (await computeHealth(new Date(Date.now() + 90_000))).checks.lastOkTurnAgeS;
    expect(age).toBeGreaterThanOrEqual(90);
    expect(age).toBeLessThan(95);
  });

  it("reports the age of the last message a real reporter sent, as information that never gates the status", async () => {
    await heartbeat();
    expect(await computeHealth()).toMatchObject({ status: 200, checks: { lastInboundAgeS: null } });
    // A test conversation's traffic never counts.
    const t = await createConversation({ isTest: true });
    await getDb().update(conversations).set({ lastInboundAt: new Date() }).where(eq(conversations.id, t.id));
    expect((await computeHealth()).checks.lastInboundAgeS).toBeNull();
    // A quiet three hours is reported, and is not a failure: the stack cannot tell it from a relay that stopped.
    const c = await createConversation({ isTest: false });
    await getDb().update(conversations).set({ lastInboundAt: new Date(Date.now() - 3 * 3_600_000) }).where(eq(conversations.id, c.id));
    const quiet = await computeHealth();
    expect(quiet.status).toBe(200);
    expect(quiet.checks.lastInboundAgeS).toBeGreaterThanOrEqual(10795);
    expect(quiet.checks.lastInboundAgeS).toBeLessThanOrEqual(10805);
    // The webhook's upsert is what stamps last_inbound_at.
    await upsertConversationByPhone({ phone: "+919999900001", name: null });
    const fresh = (await computeHealth()).checks.lastInboundAgeS;
    expect(fresh).not.toBeNull();
    expect(fresh).toBeLessThan(5);
  });

  it("is 503 when the database does not answer, and logs no error detail", async () => {
    const down = vi.spyOn(dbClient, "getSql").mockImplementation(() => {
      throw Object.assign(new Error("connect ECONNREFUSED for +919812345678"), { code: "ECONNREFUSED" });
    });
    const logged = vi.spyOn(log, "error").mockImplementation(() => undefined);
    try {
      const h = await computeHealth();
      expect(h.status).toBe(503);
      expect(h.checks.db).toBe(false);
      expect(logged).toHaveBeenCalledWith({ errorClass: "Error", code: "ECONNREFUSED" }, "health: db check failed");
      expect(JSON.stringify(logged.mock.calls)).not.toContain("9812345678");
    } finally {
      down.mockRestore();
      logged.mockRestore();
    }
  });

  it("is 503, with clockSkew, when the worker's heartbeat lies over 5 s ahead of this clock", async () => {
    await heartbeat();
    const h = await computeHealth(new Date(Date.now() - 60_000));
    expect(h.status).toBe(503);
    expect(h.checks).toMatchObject({ clockSkew: true });
    expect(h.checks.workerHeartbeatAgeS).toBeLessThan(0);
    expect((await computeHealth()).checks.clockSkew).toBe(false);
  });

  it("reads a heartbeat a few seconds ahead (written while the check ran, or a small drift) as no skew", async () => {
    await heartbeat();
    const h = await computeHealth(new Date(Date.now() - 3_000));
    expect(h.checks.workerHeartbeatAgeS).toBeLessThan(0);
    expect(h).toMatchObject({ status: 200, checks: { clockSkew: false } });
  });

  it("answers 503, without throwing, when the environment is invalid, and logs the error's class only", async () => {
    await heartbeat();
    const logged = vi.spyOn(log, "error").mockImplementation(() => undefined);
    try {
      vi.stubEnv("HELPLINE_PHONE", "99999");
      resetConfigForTests();
      const h = await computeHealth();
      expect(h.status).toBe(503);
      expect(h.checks).toMatchObject({ config: false, db: false });
      expect(logged).toHaveBeenCalledWith({ errorClass: "Error" }, "health: config invalid");
    } finally {
      vi.unstubAllEnvs();
      resetConfigForTests();
      logged.mockRestore();
    }
  });

  it("logs a failure after the database answered as a state check failure, not a database one", async () => {
    await heartbeat();
    const failing = vi.spyOn(pause, "getWorkerState").mockRejectedValueOnce(Object.assign(new Error("worker_state gone"), { code: "42P01" }));
    const logged = vi.spyOn(log, "error").mockImplementation(() => undefined);
    try {
      const h = await computeHealth();
      expect(h.status).toBe(503);
      expect(h.checks).toMatchObject({ config: true, db: true, workerHeartbeatAgeS: null, delivery: null });
      expect(logged).toHaveBeenCalledWith({ errorClass: "Error", code: "42P01" }, "health: state check failed");
      expect(logged).not.toHaveBeenCalledWith(expect.anything(), "health: db check failed");
    } finally {
      failing.mockRestore();
      logged.mockRestore();
    }
  });

  it("types the pause reason: only the reasons the code records", () => {
    // @ts-expect-error: not one of "LIMITED", "AUTH" or "eval"; checked by npm run typecheck
    void (() => pauseClaude(new Date(), "limit"));
  });

  it("leaves the queue unknown when its check fails, without failing the health check", async () => {
    await heartbeat();
    // A pgboss.job this query cannot read: the check fails with undefined_column.
    await getSql()`create schema pgboss`;
    await getSql()`create table pgboss.job (id int)`;
    const warned = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    try {
      const h = await computeHealth();
      expect(h.status).toBe(200);
      expect(h.checks.queue).toBeNull();
      expect(warned).toHaveBeenCalledWith({ errorClass: "PostgresError", code: "42703" }, "health: queue check failed");
    } finally {
      warned.mockRestore();
    }
  });
});

describe("GET /api/health", () => {
  beforeEach(async () => { await stopBoss(); await resetDb(); });
  afterEach(async () => { await stopBoss(); });

  it("answers with the computed status code, never cached", async () => {
    const down = await GET();
    expect(down.status).toBe(503);
    expect(down.headers.get("cache-control")).toBe("no-store");
    await heartbeat();
    const up = await GET();
    expect(up.status).toBe(200);
    expect(up.headers.get("cache-control")).toBe("no-store");
    expect(await up.json()).toMatchObject({ ok: true, status: 200, checks: { db: true, authErrorLastHour: false } });
  });
});

/** A reply's final send state, `minutesAgo` old on the database clock. */
async function outboundRow(conversationId: string, status: "sent" | "failed" | "sending", minutesAgo: number) {
  await getDb().insert(messages).values({
    conversationId, role: "assistant", origin: "agent", content: "x", deliveryStatus: status, createdAt: sql`now() - make_interval(mins => ${minutesAgo})`,
  });
}

/** A reporter message, `minutesAgo` old on the database clock. */
async function reporterMessage(conversationId: string, minutesAgo: number) {
  await getDb().insert(messages).values({
    conversationId, role: "user", origin: "reporter", content: "dog", createdAt: sql`now() - make_interval(mins => ${minutesAgo})`,
  });
}

async function lastDeliveredMinutesAgo(minutes: number) {
  await getDb().update(workerState).set({ lastDeliveredAt: sql`now() - make_interval(mins => ${minutes})` }).where(eq(workerState.singleton, true));
}

describe("computeHealth: delivery", () => {
  beforeEach(async () => { await stopBoss(); await resetDb(); await heartbeat(); });
  afterEach(async () => { await stopBoss(); });

  it("is 503, with delivery degraded, when the last five sends all failed within 15 minutes", async () => {
    const c = await createConversation();
    for (let i = 1; i <= 5; i++) await outboundRow(c.id, "failed", i);
    const h = await computeHealth();
    expect(h.status).toBe(503);
    expect(h.checks.delivery).toBe("degraded");
  });

  it("stays 200 when fewer than five sends failed, one of the last five went through, or a failure is over 15 minutes old", async () => {
    const c = await createConversation();
    for (let i = 1; i <= 4; i++) await outboundRow(c.id, "failed", i);
    expect(await computeHealth()).toMatchObject({ status: 200, checks: { delivery: "ok" } });
    await outboundRow(c.id, "failed", 16);
    expect(await computeHealth()).toMatchObject({ status: 200, checks: { delivery: "ok" } });
    await outboundRow(c.id, "sent", 0);
    await outboundRow(c.id, "failed", 0);
    expect(await computeHealth()).toMatchObject({ status: 200, checks: { delivery: "ok" } });
  });

  it("counts neither a test conversation's replies nor a send still in flight", async () => {
    const t = await createConversation({ isTest: true });
    for (let i = 1; i <= 5; i++) await outboundRow(t.id, "failed", i);
    const c = await createConversation();
    for (let i = 1; i <= 4; i++) await outboundRow(c.id, "failed", i);
    await outboundRow(c.id, "sending", 0);
    expect((await computeHealth()).checks.delivery).toBe("ok");
  });

  it("is 503 when a reporter message has waited over 10 minutes with nothing delivered since it came", async () => {
    const c = await createConversation();
    await reporterMessage(c.id, 11);
    expect(await computeHealth()).toMatchObject({ status: 503, checks: { delivery: "degraded", lastDeliveredAgeS: null } });
    await lastDeliveredMinutesAgo(30);
    expect((await computeHealth()).checks.delivery).toBe("degraded");
    // A delivery after the message came clears it.
    await lastDeliveredMinutesAgo(5);
    const h = await computeHealth();
    expect(h).toMatchObject({ status: 200, checks: { delivery: "ok" } });
    expect(h.checks.lastDeliveredAgeS).toBeGreaterThanOrEqual(299);
  });

  it("does not read a new message after a quiet spell as an outage until it has waited 10 minutes", async () => {
    const c = await createConversation();
    await lastDeliveredMinutesAgo(45);
    await reporterMessage(c.id, 1);
    expect((await computeHealth()).checks.delivery).toBe("ok");
    expect((await computeHealth(new Date(Date.now() + 10 * 60_000))).checks.delivery).toBe("degraded");
  });

  it("ignores messages waiting in test or human-mode conversations, and messages over an hour old", async () => {
    const t = await createConversation({ isTest: true });
    const h = await createConversation({ mode: "human" });
    const c = await createConversation();
    await reporterMessage(t.id, 11);
    await reporterMessage(h.id, 11);
    await reporterMessage(c.id, 61);
    expect(await computeHealth()).toMatchObject({ status: 200, checks: { delivery: "ok" } });
    await getDb().update(conversations).set({ mode: "agent" }).where(eq(conversations.id, h.id));
    expect((await computeHealth()).checks.delivery).toBe("degraded");
  });
});
