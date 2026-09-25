import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PgBoss } from "pg-boss";
import { resetDb, createConversation } from "../helpers/db";
import { getSql } from "@/server/db/client";
import { resetConfigForTests } from "@/server/config";
import { log } from "@/server/log";
import { getBoss, stopBoss, enqueueTurn, TURN_QUEUE, type TurnJobData } from "@/server/queue/boss";

/** pg-boss throttles on 3 s slots of the database clock. */
async function dbSlot(): Promise<{ index: number; msLeft: number }> {
  const [row] = await getSql()`select extract(epoch from clock_timestamp()) * 1000 as ms`;
  const ms = Number(row.ms);
  return { index: Math.floor(ms / 3000), msLeft: 3000 - (ms % 3000) };
}

/** Moves on to the next slot when fewer than `needMs` remain in this one; returns the slot to work in. */
async function slotWithRoom(needMs: number): Promise<number> {
  const slot = await dbSlot();
  if (slot.msLeft >= needMs) return slot.index;
  await new Promise((r) => setTimeout(r, slot.msLeft + 50));
  return (await dbSlot()).index;
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("queue", () => {
  beforeEach(async () => { await stopBoss(); await resetDb(); });
  afterEach(async () => { await stopBoss(); });

  it("creates the turn queue with singleton policy", async () => {
    const boss = await getBoss("worker");
    const q = await boss.getQueue(TURN_QUEUE);
    expect(q?.policy).toBe("singleton");
    expect(q?.retryLimit).toBe(2);
    expect(q?.expireInSeconds).toBe(120);
  });

  it("refuses the worker role while an app-role instance is starting or started", async () => {
    const starting = getBoss("app");
    await expect(getBoss("worker")).rejects.toThrow("pg-boss already started in app role");
    await starting;
    await expect(getBoss("worker")).rejects.toThrow("pg-boss already started in app role");
  });

  it("retries after a failed start instead of memoizing the failure", async () => {
    const databaseUrl = process.env.DATABASE_URL;
    const stop = vi.spyOn(PgBoss.prototype, "stop");
    process.env.DATABASE_URL = "postgres://arham:arham@127.0.0.1:1/arham_test"; // nothing listens on port 1
    resetConfigForTests();
    try {
      await expect(getBoss()).rejects.toThrow(/ECONNREFUSED/);
      expect(stop).toHaveBeenCalledTimes(1); // the half-started instance was shut down
    } finally {
      stop.mockRestore();
      process.env.DATABASE_URL = databaseUrl;
      resetConfigForTests();
    }
    const boss = await getBoss();
    expect(await boss.getQueue(TURN_QUEUE)).not.toBeNull();
  });

  it("routes pg-boss errors and warnings to the logger", async () => {
    const boss = await getBoss();
    const error = vi.spyOn(log, "error").mockImplementation(() => undefined);
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    try {
      const err = new Error("connection terminated");
      const warning = { message: "queue backlog", data: { queue: TURN_QUEUE } };
      boss.emit("error", err);
      boss.emit("warning", warning);
      expect(error).toHaveBeenCalledWith({ err }, "pg-boss error");
      expect(warn).toHaveBeenCalledWith({ warning }, "pg-boss warning");
    } finally {
      error.mockRestore();
      warn.mockRestore();
    }
  });

  it("defers a second enqueue into the next slot and deduplicates a third inside the window", async () => {
    const c = await createConversation();
    await getBoss();
    await slotWithRoom(500);
    const first = await enqueueTurn(c.id);
    const second = await enqueueTurn(c.id);
    const third = await enqueueTurn(c.id);
    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
    expect(third).toBeNull();
  });

  it("creates a job for an enqueue made after an earlier job in the same window has completed", async () => {
    const c = await createConversation();
    const boss = await getBoss("worker");
    await boss.work<TurnJobData>(TURN_QUEUE, { batchSize: 1, pollingIntervalSeconds: 0.5 }, async () => undefined);
    const slot = await slotWithRoom(1500);
    const first = await enqueueTurn(c.id, { immediate: true });
    expect(first).toBeTruthy();
    await waitFor(async () => (await boss.findJobs(TURN_QUEUE, { id: first! }))[0]?.state === "completed");
    const second = await enqueueTurn(c.id);
    expect((await dbSlot()).index).toBe(slot); // still inside the completed job's window
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
  });

  it("delivers the job data to a worker", async () => {
    const c = await createConversation();
    const boss = await getBoss("worker");
    const received: string[] = [];
    await boss.work<TurnJobData>(TURN_QUEUE, { batchSize: 1, pollingIntervalSeconds: 0.5 }, async ([job]) => {
      received.push(job.data.conversationId);
    });
    await enqueueTurn(c.id, { immediate: true });
    const deadline = Date.now() + 8000;
    while (received.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    expect(received).toEqual([c.id]);
  });
});
