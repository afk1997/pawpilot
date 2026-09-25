import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { resetDb } from "../helpers/db";
import { getDb } from "@/server/db/client";
import { conversations, messages } from "@/server/db/schema";
import { upsertConversationByPhone, storeReporterMessage } from "@/server/inbound/store";

describe("inbound store", () => {
  beforeEach(resetDb);

  it("upserts by phone, keeps the first name when a later one is missing", async () => {
    const a = await upsertConversationByPhone({ phone: "+919876543210", name: "Asha" });
    const b = await upsertConversationByPhone({ phone: "+919876543210", name: null });
    expect(b.id).toBe(a.id);
    expect(b.name).toBe("Asha");
    expect(b.lastInboundAt).not.toBeNull();
  });

  it("stores a reporter message once per provider id", async () => {
    const c = await upsertConversationByPhone({ phone: "+919876543210", name: null });
    const first = await storeReporterMessage(c.id, { providerMessageId: "m1", kind: "text", content: "hi" });
    const dup = await storeReporterMessage(c.id, { providerMessageId: "m1", kind: "text", content: "hi" });
    expect(first.inserted).toBe(true);
    expect(dup).toEqual({ inserted: false, id: null });
    const rows = await getDb().select().from(messages).where(eq(messages.conversationId, c.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].origin).toBe("reporter");
    expect(rows[0].answeredTurnId).toBeNull();
  });

  it("does not require a provider id", async () => {
    const c = await upsertConversationByPhone({ phone: "+91TEST_x1", name: null });
    await getDb().update(conversations).set({ isTest: true }).where(eq(conversations.id, c.id));
    const r1 = await storeReporterMessage(c.id, { kind: "text", content: "a" });
    const r2 = await storeReporterMessage(c.id, { kind: "text", content: "b" });
    expect(r1.inserted && r2.inserted).toBe(true);
  });
});
