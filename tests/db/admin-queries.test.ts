import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { resetDb, createConversation } from "../helpers/db";
import { getDb } from "@/server/db/client";
import { conversations, messages } from "@/server/db/schema";
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
    await getDb().update(conversations).set({ flagged: true, flagReason: "needs_human" }).where(eq(conversations.id, a.id));
    await getDb().update(conversations).set({ mode: "human" }).where(eq(conversations.id, b.id));

    const all = await listConversations({ filter: "all" });
    expect(all.map((c) => c.id).sort()).toEqual([a.id, b.id].sort());
    expect(all.find((c) => c.id === a.id)?.lastMessage).toBe("latest from a");
    expect(all.find((c) => c.id === a.id)?.messageCount).toBe(2);
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
});
