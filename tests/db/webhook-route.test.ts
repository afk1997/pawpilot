import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHmac } from "node:crypto";
import { DrizzleQueryError, eq } from "drizzle-orm";
import { resetDb, createConversation } from "../helpers/db";
import { getDb } from "@/server/db/client";
import { conversations, events, messages } from "@/server/db/schema";
import { resetConfigForTests } from "@/server/config";
import { log, maskPhone } from "@/server/log";
import * as store from "@/server/inbound/store";
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
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    resetConfigForTests();
    await stopBoss();
  });

  it("GET answers ok", async () => {
    expect(await (await GET()).text()).toBe("ok");
  });

  it("rejects a bad signature", async () => {
    const res = await POST(signed(inbound("m1", "hi"), { sign: false }));
    expect(res.status).toBe(403);
  });

  it("rejects a present but wrong signature and stores nothing", async () => {
    const raw = JSON.stringify(inbound("m1", "hi"));
    const wrong = "sha256=" + createHmac("sha256", `not-${secret}`).update(raw).digest("hex");
    const res = await POST(new Request("http://localhost/api/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "interakt-signature": wrong },
      body: raw,
    }));
    expect(res.status).toBe(403);
    expect(await getDb().select().from(conversations)).toHaveLength(0);
    expect(await getDb().select().from(messages)).toHaveLength(0);
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

  it("stores a location with its coordinates and place label", async () => {
    const body = inbound("m1", JSON.stringify({ latitude: 18.5074, longitude: 73.8077, name: "Karve Nagar" }));
    body.data.message.message_content_type = "Location";
    expect((await (await POST(signed(body))).json()).status).toBe("queued");
    const [row] = await getDb().select().from(messages);
    expect(row).toMatchObject({ kind: "location", lat: 18.5074, lng: 73.8077, placeLabel: "Karve Nagar", content: "Karve Nagar" });
  });

  it("stores a signed message whose text carries U+0000, without the NUL", async () => {
    const body = inbound("m1", "dog\u0000 injured");
    body.data.customer.traits.name = "As\u0000ha";
    expect((await POST(signed(body))).status).toBe(200);
    const [row] = await getDb().select().from(messages);
    expect(row.content).toBe("dog injured");
    const [c] = await getDb().select().from(conversations);
    expect(c.name).toBe("Asha");
  });

  it("answers duplicate for a resent message id", async () => {
    await POST(signed(inbound("m1", "hi")));
    const info = vi.spyOn(log, "info").mockImplementation(() => undefined);
    const res = await POST(signed(inbound("m1", "hi")));
    expect((await res.json()).status).toBe("duplicate");
    const rows = await getDb().select().from(messages);
    expect(rows).toHaveLength(1);
    expect(info).toHaveBeenCalledWith({ conversationId: rows[0].conversationId, providerMessageId: "m1" }, "webhook duplicate");
  });

  it("stores and enqueues once when the same message arrives twice at the same moment", async () => {
    const responses = await Promise.all([POST(signed(inbound("m1", "hi"))), POST(signed(inbound("m1", "hi")))]);
    const statuses = await Promise.all(responses.map(async (r) => (await r.json()).status));
    expect(statuses.sort()).toEqual(["duplicate", "queued"]);
    const rows = await getDb().select().from(messages);
    expect(rows).toHaveLength(1);
    expect(await (await getBoss()).findJobs(TURN_QUEUE, { key: rows[0].conversationId })).toHaveLength(1);
  });

  it("ignores status events and echoes", async () => {
    const res = await POST(signed({ type: "message_api_delivered", data: {} }));
    expect((await res.json()).status).toBe("ignored");
  });

  it("warns when a reporter message is unusable, but not for other ignored events", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const noPhone = inbound("m1", "hi", "");
    const noMessage = { type: "message_received", data: { customer: { channel_phone_number: "917003705584" } } };
    for (const body of [noPhone, noMessage]) expect((await (await POST(signed(body))).json()).status).toBe("ignored");
    expect(warn.mock.calls).toEqual([
      [{ eventType: "message_received", reason: "no_phone" }, "webhook ignored"],
      [{ eventType: "message_received", reason: "missing_fields" }, "webhook ignored"],
    ]);
    warn.mockClear();
    await POST(signed({ type: "message_api_delivered", data: {} }));
    expect(warn).not.toHaveBeenCalled();
  });

  it("refuses phones that belong to a test conversation", async () => {
    const c = await createConversation({ phone: "+917003705584", isTest: true });
    const res = await POST(signed(inbound("m9", "hi")));
    expect((await res.json()).status).toBe("ignored_test_conv");
    expect(await getDb().select().from(messages)).toHaveLength(0);
    expect(await (await getBoss()).findJobs(TURN_QUEUE, { key: c.id })).toHaveLength(0);
  });

  it("records an unknown content type once, after storing, and never fails the inbound over it", async () => {
    // The route remembers recorded types for the life of the process, so no other test may send "Reaction".
    const reaction = (id: string) => {
      const body = inbound(id, "\u{1F44D}");
      body.data.message.message_content_type = "Reaction";
      return body;
    };
    const record = vi.spyOn(store, "recordEvent").mockRejectedValueOnce(new Error("events table unavailable"));
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    expect((await (await POST(signed(reaction("m1")))).json()).status).toBe("queued");
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ contentType: "Reaction" }), "unknown_payload telemetry failed");
    const second = await (await POST(signed(reaction("m2")))).json();
    await POST(signed(reaction("m3")));
    expect(record).toHaveBeenCalledTimes(2); // retried after the failed write, then remembered
    const rows = await getDb().select().from(events).where(eq(events.kind, "unknown_payload"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      conversationId: second.conversationId,
      payload: { contentType: "Reaction", keys: expect.arrayContaining(["id", "message_content_type"]) },
    });
    expect(await getDb().select().from(messages)).toHaveLength(3);
  });

  it("rejects oversized bodies", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const big = { ...inbound("m2", "x".repeat(300_000)) };
    const res = await POST(signed(big));
    expect(res.status).toBe(413);
    expect(warn).toHaveBeenCalledWith({ declared: null, bytes: Buffer.byteLength(JSON.stringify(big)) }, "webhook body too large");
  });

  it("refuses a declared oversized body without reading it", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const req = new Request("http://localhost/api/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(300_000) },
      body: JSON.stringify(inbound("m6", "hi")),
    });
    const res = await POST(req);
    expect(res.status).toBe(413);
    expect(req.bodyUsed).toBe(false);
    expect(warn).toHaveBeenCalledWith({ declared: 300_000 }, "webhook body too large");
  });

  it("answers bad_json for malformed bodies", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const raw = "{not json";
    const req = new Request("http://localhost/api/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "interakt-signature": "sha256=" + createHmac("sha256", secret).update(raw).digest("hex") },
      body: raw,
    });
    expect((await POST(req)).status).toBe(400);
    expect(warn).toHaveBeenCalledWith({ bytes: raw.length }, "webhook body is not JSON");
  });

  it("answers 500 and logs only a masked summary when the database fails", async () => {
    const phone = "+917003705584";
    const cause = Object.assign(new Error("terminating connection due to administrator command"), {
      code: "57P01",
      detail: `Key (phone)=(${phone}) already exists.`,
    });
    vi.spyOn(store, "storeReporterMessage").mockRejectedValueOnce(
      new DrizzleQueryError('insert into "messages" ("content", "provider_message_id") values ($1, $2)', ["dog injured near the station", phone], cause)
    );
    const error = vi.spyOn(log, "error").mockImplementation(() => undefined);
    const others = (["debug", "info", "warn"] as const).map((level) => vi.spyOn(log, level).mockImplementation(() => undefined));
    const res = await POST(signed(inbound("m1", "dog injured near the station")));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ status: "error" });
    expect(error).toHaveBeenCalledWith(
      { phone: maskPhone(phone), providerMessageId: "m1", code: "57P01", pgMessage: "terminating connection due to administrator command" },
      "webhook inbound failed"
    );
    const logged = JSON.stringify([error, ...others].map((spy) => spy.mock.calls));
    for (const leak of ["7003705584", "dog injured", "Failed query", "already exists"]) expect(logged).not.toContain(leak);
  });

  it("still answers queued, and logs it, when the turn is deduplicated", async () => {
    const enqueue = vi.spyOn(queue, "enqueueTurn").mockResolvedValueOnce(null);
    const info = vi.spyOn(log, "info").mockImplementation(() => undefined);
    const json = await (await POST(signed(inbound("m3", "hi")))).json();
    expect(json.status).toBe("queued");
    expect(enqueue).toHaveBeenCalledWith(json.conversationId);
    expect(info).toHaveBeenCalledWith({ conversationId: json.conversationId }, "turn deduplicated");
  });

  it("logs raw bodies only outside production", async () => {
    const debug = vi.spyOn(log, "debug").mockImplementation(() => undefined);
    const bodyLogs = () =>
      (debug.mock.calls as unknown[][]).filter(([fields]) => typeof fields === "object" && fields !== null && "body" in fields);
    vi.stubEnv("LOG_RAW_WEBHOOKS", "1");
    resetConfigForTests();
    await POST(signed(inbound("m4", "hi")));
    expect(bodyLogs()).toHaveLength(1); // control: outside production the spy does see the raw body
    debug.mockClear();
    vi.stubEnv("NODE_ENV", "production");
    resetConfigForTests();
    expect((await POST(signed(inbound("m5", "hi")))).status).toBe(200);
    expect(bodyLogs()).toHaveLength(0);
  });
});
