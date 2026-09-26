import { and, asc, eq, gt, lt, sql } from "drizzle-orm";
import { getDb } from "../db/client";
import { conversations, messages, type Conversation, type Message } from "../db/schema";
import { sendInteractiveList, sendText, type InteractiveListSpec, type InteraktResult } from "../interakt/client";
import { recordEvent, stripNul, stripNulOrNull } from "../inbound/store";
import { flagConversation, updateConversation } from "./persist";
import { recordDelivered } from "./pause";
import type { MessageOrigin } from "../types";
import { log, safeErrorFields } from "../log";

/** Every send attempt a reply may get: the first, then two from the resend sweep. */
export const MAX_DELIVERY_ATTEMPTS = 3;

async function persistOutbound(
  conversation: Conversation,
  input: { text: string; template?: string | null; origin: MessageOrigin; turnId?: string | null; kind?: "text" | "interactive" },
  send: InteraktResult | null
): Promise<Message> {
  const [row] = await getDb()
    .insert(messages)
    .values({
      conversationId: conversation.id,
      role: "assistant",
      origin: input.origin,
      kind: input.kind ?? "text",
      content: stripNul(input.text),
      contentTemplate: stripNulOrNull(input.template),
      providerMessageId: send?.ok && send.messageId ? `out:${send.messageId}` : null,
      deliveryStatus: send === null ? "test_skipped" : send.ok ? "sent" : "failed",
      deliveryHttpStatus: send === null ? null : send.status,
      error: send && !send.ok ? send.error ?? `status=${send.status}` : null,
      turnId: input.turnId ?? null,
    })
    .returning();
  await updateConversation(conversation.id, { lastOutboundAt: new Date() });
  if (send?.ok) await recordDelivered();
  return row;
}

/**
 * Sends free-form text (skipped for test conversations) and persists the assistant message.
 * A failed send is made visible to the dispatcher: an outbound_failed event and a send_failed flag.
 */
export async function deliverText(
  conversation: Conversation,
  input: { text: string; template?: string | null; origin: MessageOrigin; turnId?: string | null }
): Promise<Message> {
  const send = conversation.isTest ? null : await sendText(conversation.phone, input.text);
  // Status only: send.error can carry Interakt's response body (a phone number, say); it is kept on messages.error.
  if (send && !send.ok) log.warn({ conversationId: conversation.id, status: send.status }, "outbound failed");
  const row = await persistOutbound(conversation, input, send);
  if (send && !send.ok) {
    // Interakt's reason goes to events, never to logs; failing to record it must not stop the flag.
    try {
      await recordEvent("outbound_failed", { status: send.status, error: send.error ?? null, messageId: row.id }, conversation.id);
    } catch {
      log.warn({ conversationId: conversation.id }, "outbound_failed event not recorded");
    }
    await flagConversation(conversation.id, "send_failed");
  }
  return row;
}

/** Sends a WhatsApp list; falls back to plain text when the list is rejected. Either row carries `turnId`. */
export async function deliverList(
  conversation: Conversation,
  input: { list: InteractiveListSpec; fallbackText: string; origin: MessageOrigin; turnId?: string | null }
): Promise<{ message: Message; usedList: boolean }> {
  const row = { text: input.fallbackText, origin: input.origin, turnId: input.turnId, kind: "interactive" as const };
  if (conversation.isTest) {
    const message = await persistOutbound(conversation, row, null);
    return { message, usedList: true };
  }
  const listSend = await sendInteractiveList(conversation.phone, input.list);
  if (listSend.ok) {
    const message = await persistOutbound(conversation, row, listSend);
    return { message, usedList: true };
  }
  log.warn({ conversationId: conversation.id, status: listSend.status }, "list send failed, falling back to text");
  // Interakt's reason goes to events, never to logs; failing to record it must not stop the fallback.
  try {
    await recordEvent("list_send_failed", { status: listSend.status, error: listSend.error ?? null }, conversation.id);
  } catch {
    log.warn({ conversationId: conversation.id }, "list_send_failed event not recorded");
  }
  const message = await deliverText(conversation, { text: input.fallbackText, origin: input.origin, turnId: input.turnId });
  return { message, usedList: false };
}

/** An Interakt status worth another attempt: no response (network error, timeout), rate limited, or a server error. */
const RETRYABLE_STATUS = sql`(${messages.deliveryHttpStatus} = 0 or ${messages.deliveryHttpStatus} = 429 or ${messages.deliveryHttpStatus} >= 500)`;

/**
 * The resend sweep. A reply to a real conversation whose send failed with a retryable status, that is under 10
 * minutes old and has had fewer than MAX_DELIVERY_ATTEMPTS attempts, is sent again from its stored text: the model
 * never runs again, so the reporter never gets a different reply. Each attempt is claimed first (its attempt count
 * must still be the one read), then the row takes the new status and an outbound_retry event records the attempt,
 * Interakt's reason included (events only, never logs). One row's failure is logged and the others still go.
 * Returns how many replies it tried.
 */
export async function resendFailedReplies(): Promise<number> {
  const db = getDb();
  const due = await db
    .select({ message: messages, phone: conversations.phone })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(
      and(
        eq(messages.role, "assistant"),
        eq(conversations.isTest, false),
        eq(messages.deliveryStatus, "failed"),
        RETRYABLE_STATUS,
        lt(messages.deliveryAttempts, MAX_DELIVERY_ATTEMPTS),
        gt(messages.createdAt, sql`now() - interval '10 minutes'`)
      )
    )
    .orderBy(asc(messages.createdAt));
  let tried = 0;
  for (const { message, phone } of due) {
    const conversationId = message.conversationId;
    const attempt = message.deliveryAttempts + 1;
    try {
      const [claimed] = await db
        .update(messages)
        .set({ deliveryAttempts: attempt })
        .where(and(eq(messages.id, message.id), eq(messages.deliveryAttempts, message.deliveryAttempts)))
        .returning({ id: messages.id });
      if (!claimed) continue;
      tried += 1;
      const send = await sendText(phone, message.content);
      await db
        .update(messages)
        .set({
          deliveryStatus: send.ok ? "sent" : "failed",
          deliveryHttpStatus: send.status,
          error: send.ok ? null : send.error ?? `status=${send.status}`,
          ...(send.ok && send.messageId && { providerMessageId: `out:${send.messageId}` }),
        })
        .where(eq(messages.id, message.id));
      await updateConversation(conversationId, { lastOutboundAt: new Date() });
      if (send.ok) await recordDelivered();
      if (send.ok) log.info({ conversationId, attempt }, "reply resent");
      else log.warn({ conversationId, attempt, status: send.status }, "resend failed");
      try {
        await recordEvent("outbound_retry", { messageId: message.id, attempt, ok: send.ok, status: send.status, error: send.error ?? null }, conversationId);
      } catch {
        log.warn({ conversationId }, "outbound_retry event not recorded");
      }
    } catch (err) {
      log.warn({ conversationId, attempt, ...safeErrorFields(err) }, "resend errored");
    }
  }
  return tried;
}
