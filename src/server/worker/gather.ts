import { and, asc, desc, eq, gte, isNull } from "drizzle-orm";
import { getDb } from "../db/client";
import { conversations, messages, turns, type Conversation, type Message } from "../db/schema";
import { extractTokens, type HandleRegistry } from "../agent/handles";

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

/** A location Claude reported longer ago than this is no longer known. */
const LOCATION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** The newest location Claude reported in the conversation's last five turns, if within LOCATION_MAX_AGE_MS of now. */
export async function lastKnownLocation(conversationId: string, now: Date): Promise<{ city: string | null; area: string | null } | null> {
  const rows = await getDb()
    .select({ structuredOutput: turns.structuredOutput })
    .from(turns)
    .where(and(eq(turns.conversationId, conversationId), gte(turns.createdAt, new Date(now.getTime() - LOCATION_MAX_AGE_MS))))
    .orderBy(desc(turns.createdAt))
    .limit(5);
  for (const { structuredOutput } of rows) {
    const loc = (structuredOutput as { location?: { city?: string | null; area?: string | null } } | null)?.location;
    if (loc && (loc.city || loc.area)) return { city: loc.city ?? null, area: loc.area ?? null };
  }
  return null;
}

/**
 * The ambulance and clinic handles in the templates of replies whose send did not fail, oldest first, each once. Only
 * handles the registry still resolves: one the model invented was never shared.
 */
export function sharedHandles(history: Message[], registry: HandleRegistry): string[] {
  const shared = new Set<string>();
  for (const m of history) {
    if (m.role !== "assistant" || !m.contentTemplate || m.deliveryStatus === "failed") continue;
    for (const t of extractTokens(m.contentTemplate)) {
      if (t.kind !== "PHONE" && registry.resolve(t.value)) shared.add(t.value.toLowerCase());
    }
  }
  return [...shared];
}
