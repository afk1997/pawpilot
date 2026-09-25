import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { messages, conversations } from "@/server/db/schema";
import { resetDb, createConversation } from "../helpers/db";
import { seedDirectory } from "../helpers/fixtures";

describe("schema", () => {
  beforeEach(resetDb);

  it("seeds the directory fixture", async () => {
    const ids = await seedDirectory();
    expect(ids.ghatkopar).toMatch(/[0-9a-f-]{36}/);
  });

  it("rejects duplicate provider message ids", async () => {
    const c = await createConversation();
    await getDb().insert(messages).values({ conversationId: c.id, role: "user", origin: "reporter", content: "hi", providerMessageId: "m1" });
    // drizzle-orm 0.45 wraps driver errors in DrizzleQueryError; the Postgres error is its cause.
    await expect(
      getDb().insert(messages).values({ conversationId: c.id, role: "user", origin: "reporter", content: "hi again", providerMessageId: "m1" })
    ).rejects.toHaveProperty("cause.message", expect.stringMatching(/duplicate key|unique/));
  });

  it("allows many messages without a provider id (test chat)", async () => {
    const c = await createConversation({ isTest: true });
    await getDb().insert(messages).values([
      { conversationId: c.id, role: "user", origin: "reporter", content: "a" },
      { conversationId: c.id, role: "user", origin: "reporter", content: "b" },
    ]);
    const rows = await getDb().select().from(messages).where(eq(messages.conversationId, c.id));
    expect(rows).toHaveLength(2);
  });

  it("defaults conversation mode to agent and flagged to false", async () => {
    const c = await createConversation();
    const [row] = await getDb().select().from(conversations).where(eq(conversations.id, c.id));
    expect(row.mode).toBe("agent");
    expect(row.flagged).toBe(false);
  });
});
