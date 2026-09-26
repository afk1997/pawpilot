import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { asc, eq, sql } from "drizzle-orm";
import { resetDb, createConversation } from "../helpers/db";
import { getDb } from "@/server/db/client";
import { ambulances, clinics, messages, turns, conversations, events } from "@/server/db/schema";
import { storeReporterMessage } from "@/server/inbound/store";
import * as store from "@/server/inbound/store";
import { gatherPending, loadHistory, sharedHandles } from "@/server/worker/gather";
import { HandleRegistry } from "@/server/agent/handles";
import { seedDirectory } from "../helpers/fixtures";
import { deliverText, deliverList, resendFailedReplies } from "@/server/worker/deliver";
import { getWorkerState } from "@/server/worker/pause";
import { createTurn, finishTurn, markAnswered, loadConversationHandles, type HandleMap } from "@/server/worker/persist";
import { setFetchForTests } from "@/server/interakt/client";
import { log } from "@/server/log";

describe("worker helpers", () => {
  beforeEach(resetDb);
  afterEach(() => {
    setFetchForTests(null);
    vi.restoreAllMocks();
  });

  it("lists as shared only delivered handles whose unit or clinic is still active", async () => {
    const ids = await seedDirectory();
    const c = await createConversation({ isTest: true });
    const registry = new HandleRegistry(c.id);
    const [ghatkopar, malad, surat] = [registry.ambulance(ids.ghatkopar), registry.ambulance(ids.malad), registry.clinic(ids.clinicSurat)];
    await deliverText(c, { text: "x", template: `Call {{AMB:${ghatkopar}}} or {{AMB:${malad}}}, or {{AMB:amb_pppppppp}}.`, origin: "agent" });
    await deliverText(c, { text: "x", template: `Clinic {{CLINIC:${surat}}}, helpline {{PHONE:helpline}}.`, origin: "agent" });
    expect(await sharedHandles(await loadHistory(c.id), registry)).toEqual([ghatkopar, malad, surat]);
    await getDb().update(ambulances).set({ active: false }).where(eq(ambulances.id, ids.malad));
    await getDb().update(clinics).set({ active: false }).where(eq(clinics.id, ids.clinicSurat));
    expect(await sharedHandles(await loadHistory(c.id), registry)).toEqual([ghatkopar]);
  });

  it("gathers only unanswered reporter messages in order", async () => {
    const c = await createConversation();
    const a = await storeReporterMessage(c.id, { kind: "text", content: "hi" });
    const b = await storeReporterMessage(c.id, { kind: "text", content: "dog injured" });
    const t = await createTurn({ conversationId: c.id, status: "ok" });
    await markAnswered([a.id!], t.id);
    const g = await gatherPending(c.id);
    expect(g?.pending.map((m) => m.id)).toEqual([b.id]);
    expect((await gatherPending("00000000-0000-0000-0000-000000000000"))).toBeNull();
  });

  it("delivers text for a real conversation through Interakt and persists it", async () => {
    const c = await createConversation({ phone: "+919876543210" });
    setFetchForTests((async () => new Response(JSON.stringify({ result: true, id: "wa-1" }), { status: 201 })) as typeof fetch);
    const m = await deliverText(c, { text: "hello +91 70000 00001", template: "hello {{AMB:amb_1}}", origin: "agent" });
    expect(m.deliveryStatus).toBe("sent");
    expect(m.contentTemplate).toBe("hello {{AMB:amb_1}}");
    const [row] = await getDb().select().from(conversations).where(eq(conversations.id, c.id));
    expect(row.lastOutboundAt).not.toBeNull();
    expect(row.flagged).toBe(false);
  });

  it("skips Interakt for test conversations", async () => {
    const c = await createConversation({ isTest: true, phone: "+91TEST_abc" });
    let called = false;
    setFetchForTests((async () => { called = true; return new Response("{}", { status: 201 }); }) as typeof fetch);
    const m = await deliverText(c, { text: "hi", origin: "system" });
    expect(called).toBe(false);
    expect(m.deliveryStatus).toBe("test_skipped");
  });

  it("records failed sends without throwing", async () => {
    const c = await createConversation({ phone: "+919876543211" });
    setFetchForTests((async () => new Response(JSON.stringify({ message: "24h window" }), { status: 400 })) as typeof fetch);
    const m = await deliverText(c, { text: "hi", origin: "agent" });
    expect(m.deliveryStatus).toBe("failed");
    expect(m.error).toMatch(/400/);
  });

  it("records an outbound_failed event and flags the conversation send_failed, keeping a reason already there", async () => {
    setFetchForTests((async () => new Response(JSON.stringify({ message: "rejected" }), { status: 400 })) as typeof fetch);
    const fresh = await createConversation({ phone: "+919876543217" });
    const flagged = await createConversation({ phone: "+919876543218" });
    await getDb().update(conversations).set({ flagged: true, flagReason: "needs_human" }).where(eq(conversations.id, flagged.id));
    const m = await deliverText(fresh, { text: "hi", origin: "agent" });
    await deliverText(flagged, { text: "hi", origin: "agent" });
    const evs = await getDb().select().from(events).where(eq(events.kind, "outbound_failed"));
    expect(evs.filter((e) => e.conversationId === fresh.id).map((e) => e.payload)).toEqual([
      { status: 400, error: expect.stringContaining("interakt 400"), messageId: m.id },
    ]);
    const flagOf = async (id: string) => {
      const [row] = await getDb().select().from(conversations).where(eq(conversations.id, id));
      return [row.flagged, row.flagReason];
    };
    expect(await flagOf(fresh.id)).toEqual([true, "send_failed"]);
    expect(await flagOf(flagged.id)).toEqual([true, "needs_human"]);
  });

  it("still flags a failed send when the outbound_failed event cannot be recorded", async () => {
    const c = await createConversation({ phone: "+919876543219" });
    setFetchForTests((async () => new Response(JSON.stringify({ message: "invalid number +919876543219" }), { status: 400 })) as typeof fetch);
    const record = vi.spyOn(store, "recordEvent").mockRejectedValueOnce(new Error("events table unavailable"));
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const m = await deliverText(c, { text: "hi", origin: "agent" });
    expect(record).toHaveBeenCalledTimes(1);
    expect(m.deliveryStatus).toBe("failed");
    expect(warn).toHaveBeenCalledWith({ conversationId: c.id }, "outbound_failed event not recorded");
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/9876543219|events table unavailable/);
    const [row] = await getDb().select().from(conversations).where(eq(conversations.id, c.id));
    expect([row.flagged, row.flagReason]).toEqual([true, "send_failed"]);
  });

  it("falls back to text when the list send fails", async () => {
    const c = await createConversation({ phone: "+919876543212" });
    let calls = 0;
    setFetchForTests((async () => {
      calls += 1;
      return calls === 1 ? new Response("{}", { status: 400 }) : new Response(JSON.stringify({ id: "x" }), { status: 201 });
    }) as typeof fetch);
    const r = await deliverList(c, { list: { body: "b", buttonLabel: "Options", rows: [{ id: "menu:ambulance", title: "A" }] }, fallbackText: "plain", origin: "system" });
    expect(r.usedList).toBe(false);
    expect(r.message.content).toBe("plain");
    expect(calls).toBe(2);
    expect(r.message.kind).toBe("text");
    expect(r.message.deliveryStatus).toBe("sent");
    const evs = await getDb().select().from(events).where(eq(events.kind, "list_send_failed"));
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ conversationId: c.id, payload: { status: 400, error: expect.stringContaining("interakt 400") } });
  });

  it("loads history chronologically and merges handles from past turns", async () => {
    const c = await createConversation({ isTest: true, phone: "+91TEST_h" });
    await storeReporterMessage(c.id, { kind: "text", content: "first" });
    const t1 = await createTurn({ conversationId: c.id, status: "ok" });
    await finishTurn(t1.id, { handles: { amb_aaaa: { kind: "ambulance", id: "id-a" } } });
    const t2 = await createTurn({ conversationId: c.id, status: "ok" });
    await finishTurn(t2.id, { handles: { cli_bbbb: { kind: "clinic", id: "id-b" } } });
    await deliverText(c, { text: "reply", origin: "agent", turnId: t2.id });
    const h = await loadHistory(c.id);
    expect(h.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(await loadConversationHandles(c.id)).toEqual({ amb_aaaa: { kind: "ambulance", id: "id-a" }, cli_bbbb: { kind: "clinic", id: "id-b" } });
    const [t] = await getDb().select().from(turns).where(eq(turns.id, t2.id));
    expect(t.handles).toBeTruthy();
    const [msg] = await getDb().select().from(messages).where(eq(messages.role, "assistant"));
    expect(msg.answeredTurnId).toBeNull();
  });

  it("forwards the list as given, localized section title included, and prefixes the outbound id", async () => {
    const c = await createConversation({ phone: "+919876543213" });
    const cap: { init?: RequestInit } = {};
    setFetchForTests((async (_url: string | URL | Request, init?: RequestInit) => {
      cap.init = init;
      return new Response(JSON.stringify({ result: true, id: "wa-list" }), { status: 201 });
    }) as typeof fetch);
    const list = { body: "b", buttonLabel: "विकल्प", sectionTitle: "सेवाएं", rows: [{ id: "menu:ambulance", title: "एम्बुलेंस" }] };
    const r = await deliverList(c, { list, fallbackText: "plain", origin: "system" });
    expect(JSON.parse(String(cap.init!.body)).data.message.action).toEqual({ button: "विकल्प", sections: [{ title: "सेवाएं", rows: list.rows }] });
    expect(r.usedList).toBe(true);
    expect(r.message).toMatchObject({ kind: "interactive", deliveryStatus: "sent", providerMessageId: "out:wa-list" });
  });

  it("keeps Interakt response bodies out of warn logs while the row keeps the error text", async () => {
    const c = await createConversation({ phone: "+919876543211" });
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    setFetchForTests((async () => new Response(JSON.stringify({ message: "invalid number +919876543211" }), { status: 400 })) as typeof fetch);
    const m = await deliverText(c, { text: "hi", origin: "agent" });
    const r = await deliverList(c, { list: { body: "b", buttonLabel: "Options", rows: [{ id: "menu:ambulance", title: "A" }] }, fallbackText: "plain", origin: "system" });
    expect(warn).toHaveBeenCalledWith({ conversationId: c.id, status: 400 }, "outbound failed");
    expect(warn).toHaveBeenCalledWith({ conversationId: c.id, status: 400 }, "list send failed, falling back to text");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("9876543211");
    expect(m.error).toContain("+919876543211");
    expect(r.message.error).toContain("+919876543211");
    const [ev] = await getDb().select().from(events).where(eq(events.kind, "list_send_failed"));
    expect(ev.payload).toMatchObject({ status: 400, error: expect.stringContaining("+919876543211") });
  });

  it("strips U+0000, which Postgres text rejects, from the stored content and template", async () => {
    const c = await createConversation({ isTest: true, phone: "+91TEST_nul" });
    const m = await deliverText(c, { text: "call\u0000 now", template: "call\u0000 {{AMB:amb_1}}", origin: "agent" });
    const [row] = await getDb().select().from(messages).where(eq(messages.id, m.id));
    expect([row.content, row.contentTemplate]).toEqual(["call now", "call {{AMB:amb_1}}"]);
  });

  it("gathers user messages only, in insertion order, around an assistant reply", async () => {
    const c = await createConversation({ isTest: true, phone: "+91TEST_p" });
    const a = await storeReporterMessage(c.id, { kind: "text", content: "dog hit by a car" });
    await deliverText(c, { text: "reply", origin: "agent" });
    const b = await storeReporterMessage(c.id, { kind: "text", content: "near the station" });
    const g = await gatherPending(c.id);
    expect(g?.pending.map((m) => m.id)).toEqual([a.id, b.id]);
  });

  it("limits history to the most recent messages, oldest first", async () => {
    const c = await createConversation({ isTest: true, phone: "+91TEST_l" });
    await storeReporterMessage(c.id, { kind: "text", content: "one" });
    await deliverText(c, { text: "two", origin: "agent" });
    await storeReporterMessage(c.id, { kind: "text", content: "three" });
    expect((await loadHistory(c.id, 2)).map((m) => m.content)).toEqual(["two", "three"]);
  });

  it("merges handles from the last 20 turns only, newer turns winning", async () => {
    const c = await createConversation({ isTest: true, phone: "+91TEST_k" });
    const turnWith = async (handles: HandleMap) => {
      const t = await createTurn({ conversationId: c.id, status: "ok" });
      await finishTurn(t.id, { handles });
    };
    await turnWith({ amb_gone: { kind: "ambulance", id: "id-gone" } });
    await turnWith({ amb_kept: { kind: "ambulance", id: "id-kept" }, amb_same: { kind: "ambulance", id: "id-old" } });
    await turnWith({ amb_same: { kind: "ambulance", id: "id-new" } });
    for (let i = 0; i < 18; i++) await createTurn({ conversationId: c.id, status: "ok" });
    expect(await loadConversationHandles(c.id)).toEqual({
      amb_kept: { kind: "ambulance", id: "id-kept" },
      amb_same: { kind: "ambulance", id: "id-new" },
    });
  });

  it("records a list for a test conversation without calling Interakt", async () => {
    const c = await createConversation({ isTest: true, phone: "+91TEST_list" });
    let called = false;
    setFetchForTests((async () => { called = true; return new Response("{}", { status: 201 }); }) as typeof fetch);
    const r = await deliverList(c, { list: { body: "b", buttonLabel: "Options", rows: [{ id: "menu:ambulance", title: "A" }] }, fallbackText: "plain", origin: "system" });
    expect(called).toBe(false);
    expect(r.usedList).toBe(true);
    expect(r.message).toMatchObject({ kind: "interactive", deliveryStatus: "test_skipped", content: "plain" });
  });

  it("stores the turn id on every outbound row it is given: text, list, a list's text fallback and a test conversation's list", async () => {
    const c = await createConversation({ phone: "+919876543221" });
    const t = await createTurn({ conversationId: c.id, status: "ok" });
    let calls = 0;
    // The second request (the first list) is rejected, so that list goes out as text.
    setFetchForTests((async () => {
      calls += 1;
      return calls === 2 ? new Response("{}", { status: 400 }) : new Response(JSON.stringify({ id: `wa-${calls}` }), { status: 201 });
    }) as typeof fetch);
    const list = { body: "b", buttonLabel: "Options", rows: [{ id: "menu:ambulance", title: "A" }] };
    const text = await deliverText(c, { text: "a", origin: "agent", turnId: t.id });
    const listAsText = await deliverList(c, { list, fallbackText: "plain", origin: "system", turnId: t.id });
    const sentList = await deliverList(c, { list, fallbackText: "plain", origin: "system", turnId: t.id });
    const untagged = await deliverText(c, { text: "b", origin: "agent" });
    expect(listAsText.usedList).toBe(false);
    expect([text, listAsText.message, sentList.message, untagged].map((m) => m.turnId)).toEqual([t.id, t.id, t.id, null]);
    const testConv = await createConversation({ isTest: true, phone: "+91TEST_turnid" });
    const tt = await createTurn({ conversationId: testConv.id, status: "ok" });
    const skipped = await deliverList(testConv, { list, fallbackText: "plain", origin: "system", turnId: tt.id });
    const [row] = await getDb().select().from(messages).where(eq(messages.id, skipped.message.id));
    expect([row.deliveryStatus, row.turnId]).toEqual(["test_skipped", tt.id]);
  });

  it("stores no provider id for a failed send, even when the error body carries one", async () => {
    const c = await createConversation({ phone: "+919876543214" });
    setFetchForTests((async () => new Response(JSON.stringify({ id: "err-1", message: "rejected" }), { status: 400 })) as typeof fetch);
    const first = await deliverText(c, { text: "a", origin: "agent" });
    const second = await deliverText(c, { text: "b", origin: "agent" });
    expect([first, second].map((m) => [m.deliveryStatus, m.providerMessageId])).toEqual([["failed", null], ["failed", null]]);
  });

  it("logs a conversation-scoped line when a list's text fallback also fails", async () => {
    const c = await createConversation({ phone: "+919876543215" });
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    setFetchForTests((async () => new Response("{}", { status: 400 })) as typeof fetch);
    const r = await deliverList(c, { list: { body: "b", buttonLabel: "Options", rows: [{ id: "menu:ambulance", title: "A" }] }, fallbackText: "plain", origin: "system" });
    expect(r).toMatchObject({ usedList: false, message: { kind: "text", deliveryStatus: "failed" } });
    expect(warn).toHaveBeenCalledWith({ conversationId: c.id, status: 400 }, "outbound failed");
  });

  it("still falls back to text when the list_send_failed event cannot be recorded", async () => {
    const c = await createConversation({ phone: "+919876543216" });
    let calls = 0;
    setFetchForTests((async () => {
      calls += 1;
      return calls === 1
        ? new Response(JSON.stringify({ message: "invalid number +919876543216" }), { status: 400 })
        : new Response(JSON.stringify({ id: "y" }), { status: 201 });
    }) as typeof fetch);
    const record = vi
      .spyOn(store, "recordEvent")
      .mockRejectedValueOnce(new Error('Failed query: insert into "events" params: {"error":"interakt 400: invalid number +919876543216"}'));
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const r = await deliverList(c, { list: { body: "b", buttonLabel: "Options", rows: [{ id: "menu:ambulance", title: "A" }] }, fallbackText: "plain", origin: "system" });
    expect(record).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ usedList: false, message: { kind: "text", deliveryStatus: "sent" } });
    expect(warn).toHaveBeenCalledWith({ conversationId: c.id }, "list_send_failed event not recorded");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("9876543216");
  });
});

/** A fetch stand-in that answers each call with the next status (the last repeats) and records the messages sent. */
function interakt(...statuses: number[]) {
  const sent: string[] = [];
  let n = 0;
  setFetchForTests((async (_url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body)) as { data: { message: unknown } };
    sent.push(typeof body.data.message === "string" ? body.data.message : JSON.stringify(body.data.message));
    const status = statuses[Math.min(n, statuses.length - 1)];
    n += 1;
    if (status === 0) throw new TypeError("fetch failed");
    return new Response(JSON.stringify(status < 300 ? { id: `wa-${n}` } : { message: "unavailable" }), { status });
  }) as typeof fetch);
  return sent;
}

/** An assistant reply already stored, as a failed first send left it, `minutesAgo` old on the database clock. */
async function storedReply(
  conversationId: string,
  opts: { content?: string; status?: string; httpStatus?: number | null; attempts?: number; minutesAgo?: number } = {}
) {
  const [row] = await getDb()
    .insert(messages)
    .values({
      conversationId, role: "assistant", origin: "agent", content: opts.content ?? "Call +91 70000 00001 now.",
      contentTemplate: "Call {{AMB:amb_abcdefgh}} now.", deliveryStatus: opts.status ?? "failed",
      deliveryHttpStatus: opts.httpStatus === undefined ? 502 : opts.httpStatus, deliveryAttempts: opts.attempts ?? 1,
      error: "interakt 502: unavailable", createdAt: sql`now() - make_interval(mins => ${opts.minutesAgo ?? 1})`,
    })
    .returning();
  return row;
}

const messageRow = async (id: string) => (await getDb().select().from(messages).where(eq(messages.id, id)))[0];
const retryEvents = async () =>
  (await getDb().select().from(events).where(eq(events.kind, "outbound_retry")).orderBy(asc(events.createdAt))).map((e) => e.payload);

describe("delivery status and the resend sweep", () => {
  beforeEach(resetDb);
  afterEach(() => {
    setFetchForTests(null);
    vi.restoreAllMocks();
  });

  it("records the send's HTTP status and one attempt, and the time of the last delivery", async () => {
    const c = await createConversation({ phone: "+919876543230" });
    interakt(502);
    const failed = await deliverText(c, { text: "a", origin: "agent" });
    expect([failed.deliveryStatus, failed.deliveryHttpStatus, failed.deliveryAttempts]).toEqual(["failed", 502, 1]);
    expect((await getWorkerState()).lastDeliveredAt).toBeNull();
    interakt(0);
    expect((await deliverText(c, { text: "b", origin: "agent" })).deliveryHttpStatus).toBe(0);
    interakt(201);
    const before = Date.now();
    const sent = await deliverText(c, { text: "c", origin: "agent" });
    expect([sent.deliveryStatus, sent.deliveryHttpStatus, sent.deliveryAttempts]).toEqual(["sent", 201, 1]);
    expect((await getWorkerState()).lastDeliveredAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
  });

  it("records no HTTP status and no delivery for a test conversation", async () => {
    const c = await createConversation({ isTest: true, phone: "+91TEST_status" });
    const m = await deliverText(c, { text: "a", origin: "agent" });
    expect([m.deliveryStatus, m.deliveryHttpStatus]).toEqual(["test_skipped", null]);
    expect((await getWorkerState()).lastDeliveredAt).toBeNull();
  });

  it("resends the stored text of a reply that failed with a retryable status, recording the attempt", async () => {
    const c = await createConversation({ phone: "+919876543231" });
    const rows = [
      await storedReply(c.id, { content: "one", httpStatus: 502 }),
      await storedReply(c.id, { content: "two", httpStatus: 429 }),
      await storedReply(c.id, { content: "three", httpStatus: 0 }),
      await storedReply(c.id, { content: "four", httpStatus: 503 }),
    ];
    const sent = interakt(201);
    expect(await resendFailedReplies()).toBe(4);
    expect(sent).toEqual(["one", "two", "three", "four"]);
    for (const [i, row] of rows.entries()) {
      expect(await messageRow(row.id)).toMatchObject({
        deliveryStatus: "sent", deliveryHttpStatus: 201, deliveryAttempts: 2, error: null, providerMessageId: `out:wa-${i + 1}`,
        content: row.content, contentTemplate: row.contentTemplate,
      });
    }
    expect(await retryEvents()).toEqual(rows.map((r) => ({ messageId: r.id, attempt: 2, ok: true, status: 201, error: null })));
    expect((await getWorkerState()).lastDeliveredAt).not.toBeNull();
    expect(await resendFailedReplies()).toBe(0);
  });

  it("never resends a reply Interakt refused for good, one out of attempts, one over 10 minutes old, or a test conversation's", async () => {
    const c = await createConversation({ phone: "+919876543232" });
    const t = await createConversation({ isTest: true, phone: "+91TEST_resend" });
    await storedReply(c.id, { httpStatus: 400 });
    await storedReply(c.id, { httpStatus: 401 });
    await storedReply(c.id, { httpStatus: 502, attempts: 3 });
    await storedReply(c.id, { httpStatus: 502, minutesAgo: 11 });
    await storedReply(c.id, { status: "sent", httpStatus: 201 });
    await storedReply(t.id, { httpStatus: 502 });
    const sent = interakt(201);
    expect(await resendFailedReplies()).toBe(0);
    expect(sent).toEqual([]);
    expect(await retryEvents()).toEqual([]);
  });

  it("stops after three attempts in all, keeping each failure on the row and in an event", async () => {
    const c = await createConversation({ phone: "+919876543233" });
    const row = await storedReply(c.id, { httpStatus: 502 });
    const sent = interakt(503, 0);
    expect(await resendFailedReplies()).toBe(1);
    expect(await messageRow(row.id)).toMatchObject({ deliveryStatus: "failed", deliveryHttpStatus: 503, deliveryAttempts: 2 });
    expect(await resendFailedReplies()).toBe(1);
    expect(await messageRow(row.id)).toMatchObject({ deliveryStatus: "failed", deliveryHttpStatus: 0, deliveryAttempts: 3, providerMessageId: null });
    expect(await resendFailedReplies()).toBe(0);
    expect(sent).toHaveLength(2);
    expect(await retryEvents()).toEqual([
      { messageId: row.id, attempt: 2, ok: false, status: 503, error: expect.stringContaining("interakt 503") },
      { messageId: row.id, attempt: 3, ok: false, status: 0, error: expect.stringContaining("fetch failed") },
    ]);
    expect((await getWorkerState()).lastDeliveredAt).toBeNull();
  });
});
