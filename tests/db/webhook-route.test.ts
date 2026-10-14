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

/** An n8n Webhook node's own output, forwarded in place of Interakt's body: the reporter's message sits under `body`. */
const envelope = () => ({ headers: { "interakt-signature": "sha256=x" }, params: {}, query: {}, body: inbound("m1", "hi") });

const ignored = (reason: string) => ({ status: "ignored", reason, event_type: "(none)" });

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

  it("rejects a bad signature, and writes no event for it", async () => {
    // Verification comes before the ignored branch: an unauthenticated sender cannot fill the events table, not even
    // with a body the route would otherwise record.
    for (const body of [inbound("m1", "hi"), envelope()]) expect((await POST(signed(body, { sign: false }))).status).toBe(403);
    expect(await getDb().select().from(events)).toHaveLength(0);
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
    // Each is also an event, with no conversation, so a pilot query sees the messages that will never be answered.
    const unusable = await getDb().select().from(events).where(eq(events.kind, "inbound_unusable"));
    expect(unusable.map((e) => [e.conversationId, e.payload])).toEqual([
      [null, { eventType: "message_received", reason: "no_phone" }],
      [null, { eventType: "message_received", reason: "missing_fields" }],
    ]);
    warn.mockClear();
    await POST(signed({ type: "message_api_delivered", data: {} }));
    expect(warn).not.toHaveBeenCalled();
    expect(await getDb().select().from(events).where(eq(events.kind, "inbound_unusable"))).toHaveLength(2);
  });

  it("warns and records a payload with no top-level type (an n8n envelope) or that is not an object, with key names only", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const unusableEvents = () => getDb().select().from(events).where(eq(events.kind, "inbound_unusable")).orderBy(events.createdAt);
    // The envelope is never unwrapped, so nothing is stored; the diagnostics name the keys, never a value.
    const res = await POST(signed(envelope()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(ignored("no_type"));
    const envelopeFields = { eventType: "(none)", reason: "no_type", keys: ["body", "headers", "params", "query"], envelope: true };
    expect(warn.mock.calls).toStrictEqual([[envelopeFields, "webhook ignored"]]);
    expect((await unusableEvents()).map((e) => [e.conversationId, e.payload])).toStrictEqual([[null, envelopeFields]]);
    expect(await getDb().select().from(conversations)).toHaveLength(0);
    expect(await getDb().select().from(messages)).toHaveLength(0);

    warn.mockClear();
    const array = await POST(signed([]));
    expect(array.status).toBe(200);
    expect(await array.json()).toEqual(ignored("non_object"));
    const arrayFields = { eventType: "(none)", reason: "non_object", jsonType: "array" };
    expect(warn.mock.calls).toStrictEqual([[arrayFields, "webhook ignored"]]);
    expect((await unusableEvents()).map((e) => [e.conversationId, e.payload])).toStrictEqual([[null, envelopeFields], [null, arrayFields]]);

    warn.mockClear();
    await POST(signed({ type: "message_api_delivered", data: {} }));
    expect(warn).not.toHaveBeenCalled();
    expect(await unusableEvents()).toHaveLength(2);
  });

  it("reports a key name that is not identifier-shaped, or holds a phone-like run, as (other)", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    // A relay node keyed by a field makes the key a value: the sender's number, the message text, or an id built on
    // the number. Only a key as code writes one is named; the rest are counted, never shown.
    const digits = "9".repeat(12);
    const keyed = { [digits]: {}, "dog injured near the station": {}, [`id_${digits}`]: {}, body: inbound("m1", "hi") };
    expect(await (await POST(signed(keyed))).json()).toEqual(ignored("no_type"));
    const fields = { eventType: "(none)", reason: "no_type", keys: ["(other)", "body", "(other)", "(other)"], envelope: true };
    expect(warn.mock.calls).toStrictEqual([[fields, "webhook ignored"]]);
    const unusable = await getDb().select().from(events).where(eq(events.kind, "inbound_unusable"));
    expect(unusable.map((e) => [e.conversationId, e.payload])).toStrictEqual([[null, fields]]);
    const written = JSON.stringify([warn.mock.calls, unusable.map((e) => e.payload)]);
    expect(written).not.toMatch(/\d{7,}/);
    expect(written).not.toContain("dog injured");
  });

  it("lists at most twenty key names of at most forty characters, and says when there were more", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const unusablePayloads = async () =>
      (await getDb().select().from(events).where(eq(events.kind, "inbound_unusable")).orderBy(events.createdAt)).map((e) => e.payload);
    const short = Array.from({ length: 20 }, (_, i) => `k${String(i + 1).padStart(2, "0")}`);
    const twentyTwo = Object.fromEntries(["a".repeat(41), "b".repeat(40), ...short].map((k) => [k, 1]));
    expect(await (await POST(signed(twentyTwo))).json()).toEqual(ignored("no_type"));
    // Sorted, then cut: the 41-character name is too long to be named, the 40-character one is not; the last two fall off.
    const truncated = { eventType: "(none)", reason: "no_type", keys: ["(other)", "b".repeat(40), ...short.slice(0, 18)], keysTruncated: true, envelope: false };
    expect(warn.mock.calls).toStrictEqual([[truncated, "webhook ignored"]]);
    expect(await unusablePayloads()).toStrictEqual([truncated]);

    warn.mockClear();
    expect(await (await POST(signed(Object.fromEntries(short.map((k) => [k, 1]))))).json()).toEqual(ignored("no_type"));
    const exact = { eventType: "(none)", reason: "no_type", keys: short, envelope: false }; // no keysTruncated key at exactly twenty
    expect(warn.mock.calls).toStrictEqual([[exact, "webhook ignored"]]);
    expect(await unusablePayloads()).toStrictEqual([truncated, exact]);
  });

  it("names the JSON type of a body that is not an object", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const cases = [["text", "string"], [null, "null"], [42, "number"], [true, "boolean"]] as const;
    for (const [body] of cases) expect(await (await POST(signed(body))).json()).toEqual(ignored("non_object"));
    const expected = cases.map(([, jsonType]) => ({ eventType: "(none)", reason: "non_object", jsonType }));
    expect(warn.mock.calls).toStrictEqual(expected.map((fields) => [fields, "webhook ignored"]));
    const unusable = await getDb().select().from(events).where(eq(events.kind, "inbound_unusable")).orderBy(events.createdAt);
    expect(unusable.map((e) => e.payload)).toStrictEqual(expected);
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
      { phone: maskPhone(phone), providerMessageId: "m1", stage: "store", code: "57P01", pgMessage: "terminating connection due to administrator command" },
      "webhook inbound failed"
    );
    const logged = JSON.stringify([error, ...others].map((spy) => spy.mock.calls));
    for (const leak of ["7003705584", "dog injured", "Failed query", "already exists"]) expect(logged).not.toContain(leak);
  });

  it("names the stage when the message was stored but its turn could not be queued", async () => {
    vi.spyOn(queue, "enqueueTurn").mockRejectedValueOnce(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }));
    const error = vi.spyOn(log, "error").mockImplementation(() => undefined);
    const res = await POST(signed(inbound("m7", "dog injured")));
    expect(res.status).toBe(500);
    expect(error).toHaveBeenCalledWith(
      { phone: maskPhone("+917003705584"), providerMessageId: "m7", stage: "enqueue", code: "ECONNREFUSED" },
      "webhook inbound failed"
    );
    // Stored: the worker's sweep answers it, and Interakt's retry is a duplicate.
    expect(await getDb().select().from(messages)).toHaveLength(1);
  });

  it("queues the turn before recording an unknown content type", async () => {
    // A type no other test sends: the route remembers the types it recorded for the life of the process.
    const poll = inbound("m8", "which one?");
    poll.data.message.message_content_type = "Poll";
    const enqueue = vi.spyOn(queue, "enqueueTurn");
    const record = vi.spyOn(store, "recordEvent");
    expect((await (await POST(signed(poll))).json()).status).toBe("queued");
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith("unknown_payload", expect.objectContaining({ contentType: "Poll" }), expect.any(String));
    expect(enqueue.mock.invocationCallOrder[0]).toBeLessThan(record.mock.invocationCallOrder[0]);
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
    vi.stubEnv("LLM_BACKEND", "claude-code"); // config refuses the fake backend in production
    resetConfigForTests();
    expect((await POST(signed(inbound("m5", "hi")))).status).toBe(200);
    expect(bodyLogs()).toHaveLength(0);
  });
});
