import { and, asc, desc, eq, ilike, or, sql } from "drizzle-orm";
import { getDb } from "../db/client";
import { conversations, messages, turns, type Conversation, type Message, type Turn } from "../db/schema";

export type ConversationFilter = "all" | "flagged" | "human" | "test";
export type ConversationSummary = Conversation & {
  lastMessage: string | null;
  lastMessageAt: Date | null;
  messageCount: number;
  /** The deliveryStatus of the newest assistant message; null when nothing was sent yet. */
  lastDeliveryStatus: string | null;
};

/** A transcript holds at most this many messages, the newest ones. */
const MAX_TRANSCRIPT_MESSAGES = 500;

/** Qualified on purpose: drizzle writes a bare `${conversations.id}` here as "id", which inside a subquery on messages means messages.id. */
const conversationIdRef = sql`${conversations}.${sql.identifier(conversations.id.name)}`;

/** An ILIKE pattern for `text` anywhere in the value, with any `\`, `%` and `_` in it matched as themselves. */
function containsPattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

export async function listConversations(opts: { filter: ConversationFilter; search?: string; limit?: number }): Promise<ConversationSummary[]> {
  const db = getDb();
  const conds = [];
  if (opts.filter === "test") conds.push(eq(conversations.isTest, true));
  else conds.push(eq(conversations.isTest, false));
  if (opts.filter === "flagged") conds.push(eq(conversations.flagged, true));
  if (opts.filter === "human") conds.push(eq(conversations.mode, "human"));
  if (opts.search && opts.search.trim()) {
    const q = containsPattern(opts.search.trim());
    conds.push(or(ilike(conversations.phone, q), ilike(conversations.name, q))!);
  }
  const rows = await db
    .select({
      conversation: conversations,
      lastMessage: sql<string | null>`(select m.content from messages m where m.conversation_id = ${conversationIdRef} order by m.created_at desc limit 1)`,
      lastMessageAt: sql<Date | null>`(select m.created_at from messages m where m.conversation_id = ${conversationIdRef} order by m.created_at desc limit 1)`,
      messageCount: sql<number>`(select count(*)::int from messages m where m.conversation_id = ${conversationIdRef})`,
      lastDeliveryStatus: sql<string | null>`(select m.delivery_status from messages m where m.conversation_id = ${conversationIdRef} and m.role = 'assistant' order by m.created_at desc limit 1)`,
    })
    .from(conversations)
    .where(and(...conds))
    .orderBy(desc(conversations.updatedAt))
    .limit(opts.limit ?? 100);
  return rows.map((r) => ({
    ...r.conversation,
    lastMessage: r.lastMessage,
    lastMessageAt: r.lastMessageAt ? new Date(r.lastMessageAt) : null,
    messageCount: Number(r.messageCount),
    lastDeliveryStatus: r.lastDeliveryStatus,
  }));
}

export async function getConversationDetail(id: string): Promise<{ conversation: Conversation; messages: Message[]; turns: Turn[] } | null> {
  const db = getDb();
  const [conversation] = await db.select().from(conversations).where(eq(conversations.id, id));
  if (!conversation) return null;
  const [newestFirst, ts] = await Promise.all([
    db.select().from(messages).where(eq(messages.conversationId, id)).orderBy(desc(messages.createdAt)).limit(MAX_TRANSCRIPT_MESSAGES),
    db.select().from(turns).where(eq(turns.conversationId, id)).orderBy(asc(turns.createdAt)),
  ]);
  return { conversation, messages: newestFirst.reverse(), turns: ts };
}
