import { and, asc, desc, eq, gte, isNull } from "drizzle-orm";
import { getDb } from "../db/client";
import { conversations, messages, turns, type Conversation, type Message } from "../db/schema";
import { extractTokens, type HandleKind, type HandleRegistry } from "../agent/handles";
import { getAmbulancesByIds, getClinicsByIds } from "../directory/repo";

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

/** A location recorded longer ago than this is no longer known. */
const LOCATION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * The location the last turn recorded: the newest `location` in the structured output of the conversation's last five
 * turns (Claude's report, or the place a fast path matched), if within LOCATION_MAX_AGE_MS of now.
 */
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
 * handles the registry still resolves (one the model invented was never shared) and whose unit or clinic is still
 * active (the model must not offer a retired one again): one lookup per kind.
 */
export async function sharedHandles(history: Message[], registry: HandleRegistry): Promise<string[]> {
  const shared = new Map<string, { kind: HandleKind; id: string }>();
  for (const m of history) {
    if (m.role !== "assistant" || !m.contentTemplate || m.deliveryStatus === "failed") continue;
    for (const t of extractTokens(m.contentTemplate)) {
      const ref = t.kind === "PHONE" ? undefined : registry.resolve(t.value);
      if (ref && !shared.has(t.value.toLowerCase())) shared.set(t.value.toLowerCase(), ref);
    }
  }
  const idsOf = (kind: HandleKind) => [...new Set([...shared.values()].filter((r) => r.kind === kind).map((r) => r.id))];
  const [units, clinicRows] = await Promise.all([getAmbulancesByIds(idsOf("ambulance")), getClinicsByIds(idsOf("clinic"))]);
  return [...shared].filter(([, ref]) => (ref.kind === "ambulance" ? units : clinicRows).has(ref.id)).map(([handle]) => handle);
}
