import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { desc, eq } from "drizzle-orm";
import { resetDb, createConversation } from "../helpers/db";
import { getDb } from "@/server/db/client";
import { conversations, messages, turns } from "@/server/db/schema";
import { storeReporterMessage } from "@/server/inbound/store";
import { setFetchForTests } from "@/server/interakt/client";
import { createTurn } from "@/server/worker/persist";
import { deliverText } from "@/server/worker/deliver";
import { listConversations, getConversationDetail } from "@/server/admin/queries";

/** Every Interakt send answers with `status`: 201 carries a message id, anything else a rejection. */
const interaktAnswers = (status: number) =>
  setFetchForTests((async () => new Response(JSON.stringify(status < 300 ? { id: "wamid-1" } : { message: "rejected" }), { status })) as typeof fetch);

describe("admin queries", () => {
  beforeEach(resetDb);
  afterEach(() => setFetchForTests(null));

  it("lists with filters, search and last message preview", async () => {
    const a = await createConversation({ phone: "+919876500011" });
    const b = await createConversation({ phone: "+919876500022" });
    const t = await createConversation({ phone: "+91TEST_zz", isTest: true });
    await storeReporterMessage(a.id, { kind: "text", content: "first" });
    await storeReporterMessage(a.id, { kind: "text", content: "latest from a" });
    for (const content of ["b1", "b2", "latest from b"]) await storeReporterMessage(b.id, { kind: "text", content });
    await getDb().update(conversations).set({ flagged: true, flagReason: "needs_human" }).where(eq(conversations.id, a.id));
    await getDb().update(conversations).set({ mode: "human" }).where(eq(conversations.id, b.id));

    const all = await listConversations({ filter: "all" });
    expect(all.map((c) => c.id).sort()).toEqual([a.id, b.id].sort());
    expect(all.find((c) => c.id === a.id)?.lastMessage).toBe("latest from a");
    expect(all.find((c) => c.id === a.id)?.messageCount).toBe(2);
    // Each conversation's own newest message, count and time, not the table's.
    const newestAt = async (conversationId: string) =>
      (await getDb().select().from(messages).where(eq(messages.conversationId, conversationId)).orderBy(desc(messages.createdAt)).limit(1))[0].createdAt;
    expect(all.find((c) => c.id === a.id)?.lastMessageAt).toEqual(await newestAt(a.id));
    expect(all.find((c) => c.id === b.id)).toMatchObject({ lastMessage: "latest from b", messageCount: 3, lastMessageAt: await newestAt(b.id) });
    expect((await listConversations({ filter: "flagged" })).map((c) => c.id)).toEqual([a.id]);
    expect((await listConversations({ filter: "human" })).map((c) => c.id)).toEqual([b.id]);
    expect((await listConversations({ filter: "test" })).map((c) => c.id)).toEqual([t.id]);
    expect((await listConversations({ filter: "all", search: "0022" })).map((c) => c.id)).toEqual([b.id]);

    // The send-failed marker: the newest assistant message's delivery status. A reporter message after it does not
    // hide it, and a later successful send replaces it.
    const deliveryStatus = async (id: string) => (await listConversations({ filter: "all" })).find((c) => c.id === id)?.lastDeliveryStatus;
    interaktAnswers(400);
    await deliverText(b, { text: "reply to b", origin: "agent" });
    await storeReporterMessage(b.id, { kind: "text", content: "hello?" });
    expect(await deliveryStatus(b.id)).toBe("failed");
    expect(await deliveryStatus(a.id)).toBeNull();
    interaktAnswers(201);
    await deliverText(b, { text: "second reply to b", origin: "agent" });
    expect(await deliveryStatus(b.id)).toBe("sent");
  });

  it("searches names case-insensitively and matches %, _ and \\ in the search text as themselves", async () => {
    const named = async (phone: string, name: string) => {
      const c = await createConversation({ phone });
      await getDb().update(conversations).set({ name }).where(eq(conversations.id, c.id));
      return c;
    };
    const percent = await named("+919876500044", "100% Seva");
    const underscore = await named("+919876500055", "seva_team");
    const backslash = await named("+919876500066", "Seva\\Ghar");
    const found = async (search: string) => (await listConversations({ filter: "all", search })).map((c) => c.id);
    expect((await found("SEVA")).sort()).toEqual([percent.id, underscore.id, backslash.id].sort());
    expect(await found("%")).toEqual([percent.id]);
    expect(await found("_")).toEqual([underscore.id]);
    expect(await found("\\")).toEqual([backslash.id]);
    // A number typed with spaces or dashes matches the stored "+91…" form; other text keeps its spaces.
    expect(await found("98765 00055")).toEqual([underscore.id]);
    expect(await found("+91-98765-00066")).toEqual([backslash.id]);
    expect(await found("100% Seva")).toEqual([percent.id]);
  });

  it("returns the detail with messages and turns", async () => {
    const c = await createConversation({ isTest: true, phone: "+91TEST_d" });
    await storeReporterMessage(c.id, { kind: "text", content: "hi" });
    const turn = await createTurn({ conversationId: c.id, status: "ok", model: "fake" });
    await deliverText(c, { text: "hello", origin: "agent", turnId: turn.id });
    const d = (await getConversationDetail(c.id))!;
    expect(d.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(d.turns).toHaveLength(1);
    expect(d.messages[1].turnId).toBe(turn.id);
    expect(await getConversationDetail("00000000-0000-0000-0000-000000000000")).toBeNull();
  });

  it("returns only the newest 500 messages of a long conversation, oldest first", async () => {
    const c = await createConversation({ isTest: true, phone: "+91TEST_long" });
    const start = Date.now() - 3_600_000;
    await getDb()
      .insert(messages)
      .values(
        Array.from({ length: 502 }, (_, i) => ({
          conversationId: c.id,
          role: "user" as const,
          origin: "reporter" as const,
          content: `m${i}`,
          createdAt: new Date(start + i * 1000),
        }))
      );
    const d = (await getConversationDetail(c.id))!;
    expect(d.messages.map((m) => m.content)).toEqual(Array.from({ length: 500 }, (_, i) => `m${i + 2}`));
  });

  it("once the cap is hit keeps only the turns the kept messages can show, and below it every turn", async () => {
    const start = Date.now() - 3_600_000;
    const at = (seconds: number) => new Date(start + seconds * 1000);
    const turnAt = async (conversationId: string, seconds: number) =>
      (await getDb().insert(turns).values({ conversationId, status: "ok", createdAt: at(seconds) }).returning())[0];
    const long = await createConversation({ isTest: true, phone: "+91TEST_turns" });
    const early = await turnAt(long.id, 0.5); // sent m0, which is not kept: left out
    const sender = await turnAt(long.id, 1.5); // older than the oldest kept message, m2, which it sent: kept
    const later = await turnAt(long.id, 300.5); // newer than the oldest kept message: kept
    const sentBy = new Map([[0, early.id], [2, sender.id]]);
    await getDb()
      .insert(messages)
      .values(
        Array.from({ length: 502 }, (_, i) => ({
          conversationId: long.id,
          role: sentBy.has(i) ? ("assistant" as const) : ("user" as const),
          origin: sentBy.has(i) ? ("agent" as const) : ("reporter" as const),
          content: `m${i}`,
          turnId: sentBy.get(i) ?? null,
          createdAt: at(i),
        }))
      );
    const capped = (await getConversationDetail(long.id))!;
    expect(capped.messages[0].content).toBe("m2");
    expect(capped.turns.map((t) => t.id)).toEqual([sender.id, later.id]);

    const short = await createConversation({ isTest: true, phone: "+91TEST_short" });
    const older = await turnAt(short.id, 0.5); // older than every message and sent none: kept, the cap is not hit
    await storeReporterMessage(short.id, { kind: "text", content: "hi" });
    expect((await getConversationDetail(short.id))!.turns.map((t) => t.id)).toEqual([older.id]);
  });
});
