import { desc, eq, inArray, sql } from "drizzle-orm";
import type { HandleMap } from "../agent/handles";
import { getDb, type Db } from "../db/client";
import { conversations, messages, turns, type Conversation, type Message, type NewTurn, type Turn } from "../db/schema";
import type { InteraktResult } from "../interakt/client";
import type { TurnStatus } from "../types";

export async function createTurn(input: { conversationId: string; status: TurnStatus; model?: string | null; effort?: string | null }): Promise<Turn> {
  const [row] = await getDb()
    .insert(turns)
    .values({ conversationId: input.conversationId, status: input.status, model: input.model ?? null, effort: input.effort ?? null })
    .returning();
  return row;
}

export async function finishTurn(id: string, patch: Partial<Omit<NewTurn, "id" | "conversationId" | "createdAt">>): Promise<void> {
  await getDb().update(turns).set(patch).where(eq(turns.id, id));
}

/** `db`: a transaction, when the marking must commit with other writes (deliver.ts's write-ahead). */
export async function markAnswered(messageIds: string[], turnId: string | null, db: Pick<Db, "update"> = getDb()): Promise<void> {
  if (messageIds.length === 0) return;
  await db.update(messages).set({ answeredTurnId: turnId }).where(inArray(messages.id, messageIds));
}

/**
 * A stored reply takes the outcome of a send: sent or failed, Interakt's HTTP status, its error text and message id.
 * `kind`: what went out when it differs from what was stored (a list that went out as plain text).
 */
export async function recordSendResult(messageId: string, send: InteraktResult, kind?: "text"): Promise<Message> {
  const [row] = await getDb()
    .update(messages)
    .set({
      deliveryStatus: send.ok ? "sent" : "failed",
      deliveryHttpStatus: send.status,
      error: send.ok ? null : send.error ?? `status=${send.status}`,
      ...(send.ok && send.messageId && { providerMessageId: `out:${send.messageId}` }),
      ...(kind && { kind }),
    })
    .where(eq(messages.id, messageId))
    .returning();
  return row;
}

export async function updateConversation(
  id: string,
  patch: Partial<Omit<Conversation, "id" | "phone" | "isTest" | "createdAt" | "updatedAt">>
): Promise<void> {
  await getDb().update(conversations).set({ ...patch, updatedAt: new Date() }).where(eq(conversations.id, id));
}

/**
 * Flags a conversation for the dispatcher in one DB-side update. A reason already
 * on a flagged conversation (a dispatcher's, say) is kept, even one set after the
 * caller read the row.
 */
export async function flagConversation(id: string, reason: string): Promise<void> {
  await getDb()
    .update(conversations)
    .set({
      flagged: true,
      flagReason: sql`case when ${conversations.flagged} then ${conversations.flagReason} else ${reason} end`,
      updatedAt: sql`now()`,
    })
    .where(eq(conversations.id, id));
}

export type { HandleMap };

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
