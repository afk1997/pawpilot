import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createConversation, resetDb } from "../helpers/db";
import { computeHealth } from "@/server/health";
import { heartbeat, pauseClaude, recordOkTurn } from "@/server/worker/pause";
import { recordEvent } from "@/server/inbound/store";
import { enqueueTurn, stopBoss } from "@/server/queue/boss";
import { resetConfigForTests } from "@/server/config";
import * as dbClient from "@/server/db/client";
import { getSql } from "@/server/db/client";
import { log } from "@/server/log";
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
