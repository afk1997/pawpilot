import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { resetDb, createConversation } from "../helpers/db";
import { getDb } from "@/server/db/client";
import { messages, turns, conversations } from "@/server/db/schema";
import { storeReporterMessage } from "@/server/inbound/store";
import { gatherPending, loadHistory } from "@/server/worker/gather";
import { deliverText, deliverList } from "@/server/worker/deliver";
import { createTurn, finishTurn, markAnswered, loadConversationHandles } from "@/server/worker/persist";
import { setFetchForTests } from "@/server/interakt/client";

describe("worker helpers", () => {
  beforeEach(resetDb);
  afterEach(() => setFetchForTests(null));

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
});
