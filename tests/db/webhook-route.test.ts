import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { resetDb, createConversation } from "../helpers/db";
import { getDb } from "@/server/db/client";
import { conversations, messages } from "@/server/db/schema";
import { log } from "@/server/log";
import * as queue from "@/server/queue/boss";
import { getBoss, stopBoss, TURN_QUEUE } from "@/server/queue/boss";
import { POST, GET } from "@/app/api/webhook/route";

const secret = process.env.INTERAKT_WEBHOOK_SECRET!;

function signed(body: unknown, opts: { sign?: boolean } = { sign: true }) {
  const raw = JSON.stringify(body);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.sign) headers["interakt-signature"] = "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");
  return new Request("http://localhost/api/webhook", { method: "POST", headers, body: raw });
}

const inbound = (id: string, text: string, phone = "917003705584") => ({
  version: "1.0", timestamp: "2026-09-25T10:00:00Z", type: "message_received",
  data: {
    customer: { id: "c1", channel_phone_number: phone, traits: { name: "Asha" } },
    message: { id, chat_message_type: "CustomerMessage", message_content_type: "Text", message: text, received_at_utc: "2026-09-25T10:00:00Z" },
  },
});

describe("POST /api/webhook", () => {
  beforeEach(async () => { await stopBoss(); await resetDb(); });
  afterEach(async () => { await stopBoss(); });

  it("GET answers ok", async () => {
    expect(await (await GET()).text()).toBe("ok");
  });

  it("rejects a bad signature", async () => {
    const res = await POST(signed(inbound("m1", "hi"), { sign: false }));
    expect(res.status).toBe(403);
  });

  it("stores the message, upserts the conversation and enqueues a turn", async () => {
    const res = await POST(signed(inbound("m1", "dog injured in ghatkopar")));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe("queued");
    const [c] = await getDb().select().from(conversations).where(eq(conversations.phone, "+917003705584"));
    expect(c.name).toBe("Asha");
    const rows = await getDb().select().from(messages).where(eq(messages.conversationId, c.id));
    expect(rows).toHaveLength(1);
    // Not getQueue(): its counts are a cache that only a supervising (worker) instance refreshes.
    const jobs = await (await getBoss()).findJobs(TURN_QUEUE, { key: c.id });
    expect(jobs.map((j) => j.data)).toEqual([{ conversationId: c.id }]);
  });

  it("answers duplicate for a resent message id", async () => {
    await POST(signed(inbound("m1", "hi")));
    const res = await POST(signed(inbound("m1", "hi")));
    expect((await res.json()).status).toBe("duplicate");
    const rows = await getDb().select().from(messages);
    expect(rows).toHaveLength(1);
  });

  it("ignores status events and echoes", async () => {
    const res = await POST(signed({ type: "message_api_delivered", data: {} }));
    expect((await res.json()).status).toBe("ignored");
  });

  it("refuses phones that belong to a test conversation", async () => {
    await createConversation({ phone: "+917003705584", isTest: true });
    const res = await POST(signed(inbound("m9", "hi")));
    expect((await res.json()).status).toBe("ignored_test_conv");
  });

  it("rejects oversized bodies", async () => {
    const big = { ...inbound("m2", "x".repeat(300_000)) };
    const res = await POST(signed(big));
    expect(res.status).toBe(413);
  });

  it("answers bad_json for malformed bodies", async () => {
    const raw = "{not json";
    const req = new Request("http://localhost/api/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "interakt-signature": "sha256=" + createHmac("sha256", secret).update(raw).digest("hex") },
      body: raw,
    });
    expect((await POST(req)).status).toBe(400);
  });

  it("still answers queued, and logs it, when the turn is deduplicated", async () => {
    const enqueue = vi.spyOn(queue, "enqueueTurn").mockResolvedValueOnce(null);
    const info = vi.spyOn(log, "info").mockImplementation(() => undefined);
    try {
      const json = await (await POST(signed(inbound("m3", "hi")))).json();
      expect(json.status).toBe("queued");
      expect(enqueue).toHaveBeenCalledWith(json.conversationId);
      expect(info).toHaveBeenCalledWith({ conversationId: json.conversationId }, "turn deduplicated");
    } finally {
      enqueue.mockRestore();
      info.mockRestore();
    }
  });
});
