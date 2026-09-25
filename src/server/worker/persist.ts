import { desc, eq, inArray } from "drizzle-orm";
import { getDb } from "../db/client";
import { conversations, messages, turns, type Conversation, type NewTurn, type Turn } from "../db/schema";
import type { TurnStatus } from "../types";

export async function createTurn(input: { conversationId: string; status: TurnStatus; model?: string | null; effort?: string | null }): Promise<Turn> {
  const [row] = await getDb()
    .insert(turns)
    .values({ conversationId: input.conversationId, status: input.status, model: input.model ?? null, effort: input.effort ?? null })
    .returning();
  return row;
}

export async function finishTurn(id: string, patch: Partial<NewTurn>): Promise<void> {
  await getDb().update(turns).set(patch).where(eq(turns.id, id));
}

export async function markAnswered(messageIds: string[], turnId: string | null): Promise<void> {
  if (messageIds.length === 0) return;
  await getDb().update(messages).set({ answeredTurnId: turnId }).where(inArray(messages.id, messageIds));
}

export async function updateConversation(id: string, patch: Partial<Conversation>): Promise<void> {
  await getDb().update(conversations).set({ ...patch, updatedAt: new Date() }).where(eq(conversations.id, id));
}

export type HandleMap = Record<string, { kind: "ambulance" | "clinic"; id: string }>;

/** Union of the handle maps stored on the last 20 turns, newest winning. */
export async function loadConversationHandles(conversationId: string): Promise<HandleMap> {
  const rows = await getDb()
    .select({ handles: turns.handles })
    .from(turns)
    .where(eq(turns.conversationId, conversationId))
    .orderBy(desc(turns.createdAt))
    .limit(20);
  const merged: HandleMap = {};
  for (const r of rows.reverse()) Object.assign(merged, (r.handles ?? {}) as HandleMap);
  return merged;
}
