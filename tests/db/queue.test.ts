import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resetDb, createConversation } from "../helpers/db";
import { getBoss, stopBoss, enqueueTurn, TURN_QUEUE, type TurnJobData } from "@/server/queue/boss";

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

  it("deduplicates enqueues for the same conversation inside the singleton window", async () => {
    const c = await createConversation();
    const first = await enqueueTurn(c.id);
    const second = await enqueueTurn(c.id);
    expect(first).toBeTruthy();
    expect(second).toBeNull();
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
