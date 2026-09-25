import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { getDb } from "../db/client";
import { conversations, messages, type Conversation, type Message } from "../db/schema";

export async function gatherPending(conversationId: string): Promise<{ conversation: Conversation; pending: Message[] } | null> {
  const db = getDb();
  const [conversation] = await db.select().from(conversations).where(eq(conversations.id, conversationId));
  if (!conversation) return null;
  const pending = await db
    .select()
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.role, "user"), isNull(messages.answeredTurnId)))
    .orderBy(asc(messages.createdAt));
  return { conversation, pending };
}

/** Last `limit` messages, oldest first. */
export async function loadHistory(conversationId: string, limit = 30): Promise<Message[]> {
  const rows = await getDb()
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(messages.createdAt))
    .limit(limit);
  return rows.reverse();
}
