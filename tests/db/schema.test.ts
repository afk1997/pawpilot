import { describe, it, expect, beforeEach } from "vitest";
import { eq, sql } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { messages, conversations } from "@/server/db/schema";
import { assertTestDatabase, resetDb, createConversation } from "../helpers/db";
import { seedDirectory } from "../helpers/fixtures";

describe("schema", () => {
  beforeEach(resetDb);

  it("lets resetDb truncate only a database whose name ends in _test", async () => {
    expect(() => assertTestDatabase("arham")).toThrow('resetDb refuses database "arham": its name must end in _test');
    expect(() => assertTestDatabase("arham_test_copy")).toThrow(/must end in _test/);
    expect(() => assertTestDatabase("arham_test")).not.toThrow();
  });

  it("indexes messages by the turn that sent them and by the turn that answered them", async () => {
    const rows = await getDb().execute<{ indexname: string; indexdef: string }>(
      sql`select indexname, indexdef from pg_indexes where tablename = 'messages' and indexname in ('messages_turn_idx', 'messages_answered_turn_idx') order by indexname`
    );
    expect(rows.map((r) => [r.indexname, /\((\w+)\)$/.exec(r.indexdef)?.[1]])).toEqual([
      ["messages_answered_turn_idx", "answered_turn_id"],
      ["messages_turn_idx", "turn_id"],
    ]);
  });

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
