import { and, desc, eq, inArray, not, sql } from "drizzle-orm";
import type { HandleMap } from "../agent/handles";
import { getDb, type Db } from "../db/client";
import { conversations, messages, turns, type Conversation, type Message, type NewTurn, type Turn } from "../db/schema";
import type { InteraktResult } from "../interakt/client";
import type { TurnStatus } from "../types";

/** `structuredOutput` and `handles`: an audit known before the send (the fast path's), written with the row itself. */
export async function createTurn(input: {
  conversationId: string; status: TurnStatus; model?: string | null; effort?: string | null;
  structuredOutput?: unknown; handles?: HandleMap | null;
}): Promise<Turn> {
  const [row] = await getDb()
    .insert(turns)
    .values({
      conversationId: input.conversationId, status: input.status, model: input.model ?? null, effort: input.effort ?? null,
      ...(input.structuredOutput !== undefined && { structuredOutput: input.structuredOutput }),
      ...(input.handles !== undefined && { handles: input.handles }),
    })
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
 * A reply its turn failed to deliver went out after all (the resend sweep's): that turn is no longer a delivery
 * failure. Only a turn whose error is delivery_failed changes; its status becomes ok, as a delivered reply's is.
 */
export async function clearDeliveryFailure(turnId: string): Promise<void> {
  await getDb().update(turns).set({ status: "ok", error: null }).where(and(eq(turns.id, turnId), eq(turns.error, "delivery_failed")));
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
 * How much a flag reason says, for the ones code sets: a reporter who wants a person, or a reply that did not go out,
 * says more than "the fallback answered", which a Claude pause puts on every conversation. Any other reason (a
 * dispatcher's, turn_failed) is never replaced.
 */
const FLAG_RANK: Record<string, number> = { claude_unavailable: 0, needs_human: 1, send_failed: 1 };

/**
 * Flags a conversation for the dispatcher in one DB-side update. A reason already on a flagged conversation is kept,
 * even one set after the caller read the row, unless FLAG_RANK ranks it below the new one.
 */
export async function flagConversation(id: string, reason: string): Promise<void> {
  const outranked = Object.keys(FLAG_RANK).filter((r) => FLAG_RANK[r] < (FLAG_RANK[reason] ?? -1));
  const keep = outranked.length === 0
    ? eq(conversations.flagged, true)
    : and(eq(conversations.flagged, true), not(inArray(conversations.flagReason, outranked)));
  await getDb()
    .update(conversations)
    .set({
      flagged: true,
      flagReason: sql`case when ${keep} then ${conversations.flagReason} else ${reason} end`,
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
