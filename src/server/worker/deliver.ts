import { and, asc, eq, gt, lt, or, sql } from "drizzle-orm";
import { getDb } from "../db/client";
import { conversations, messages, type Conversation, type Message } from "../db/schema";
import { sendInteractiveList, sendText, type InteractiveListSpec, type InteraktResult } from "../interakt/client";
import { recordEvent, stripNul, stripNulOrNull } from "../inbound/store";
import { flagConversation, markAnswered, recordSendResult, updateConversation } from "./persist";
import { recordDelivered } from "./pause";
import type { MessageOrigin } from "../types";
import { log, safeErrorFields } from "../log";

/** Every send attempt a reply may get: the first, then two from the resend sweep. */
export const MAX_DELIVERY_ATTEMPTS = 3;

/** A reply to deliver. `answers`: the reporter messages it answers, marked with `turnId` before the send. */
interface OutboundInput {
  text: string;
  template?: string | null;
  origin: MessageOrigin;
  turnId?: string | null;
  answers?: string[];
}

/**
 * Write-ahead (spec §5.2): stores the reply as "sending" ("test_skipped" for a test conversation, which never reaches
 * Interakt) and marks the messages it answers, in one transaction, before any send. A crash or a failed write after
 * the send then leaves nothing pending for a retry to answer a second time; the row left "sending" stays visible, and
 * the resend sweep takes it up after 2 minutes.
 */
async function writeAhead(conversation: Conversation, input: OutboundInput & { kind: "text" | "interactive" }): Promise<Message> {
  const answers = input.answers ?? [];
  if (answers.length > 0 && !input.turnId) throw new Error("a reply that answers messages needs its turn id");
  return getDb().transaction(async (tx) => {
    const [row] = await tx
      .insert(messages)
      .values({
        conversationId: conversation.id,
        role: "assistant",
        origin: input.origin,
        kind: input.kind,
        content: stripNul(input.text),
        contentTemplate: stripNulOrNull(input.template),
        deliveryStatus: conversation.isTest ? "test_skipped" : "sending",
        turnId: input.turnId ?? null,
      })
      .returning();
    await markAnswered(answers, input.turnId ?? null, tx);
    return row;
  });
}

/**
 * The stored reply takes the send's outcome and the conversation's last outbound time moves. An accepted send is
 * recorded for the health check; a failed one is made visible to the dispatcher: an outbound_failed event and a
 * send_failed flag.
 */
async function afterSend(conversation: Conversation, row: Message, send: InteraktResult, kind?: "text"): Promise<Message> {
  // Status only: send.error can carry Interakt's response body (a phone number, say); it is kept on messages.error.
  if (!send.ok) log.warn({ conversationId: conversation.id, status: send.status }, "outbound failed");
  const updated = await recordSendResult(row.id, send, kind);
  await updateConversation(conversation.id, { lastOutboundAt: new Date() });
  if (send.ok) {
    await recordDelivered();
    return updated;
  }
  // Interakt's reason goes to events, never to logs; failing to record it must not stop the flag.
  try {
    await recordEvent("outbound_failed", { status: send.status, error: send.error ?? null, messageId: row.id }, conversation.id);
  } catch {
    log.warn({ conversationId: conversation.id }, "outbound_failed event not recorded");
  }
  await flagConversation(conversation.id, "send_failed");
  return updated;
}

/** A test conversation's reply: stored, never sent. */
async function skipSend(conversation: Conversation, row: Message): Promise<Message> {
  await updateConversation(conversation.id, { lastOutboundAt: new Date() });
  return row;
}

/** Sends free-form text (skipped for test conversations), write-ahead: see writeAhead and afterSend. */
export async function deliverText(conversation: Conversation, input: OutboundInput): Promise<Message> {
  const row = await writeAhead(conversation, { ...input, kind: "text" });
  if (conversation.isTest) return skipSend(conversation, row);
  return afterSend(conversation, row, await sendText(conversation.phone, input.text));
}

/**
 * Sends a WhatsApp list; when the list is rejected, the same row goes out as plain text (one reply, one row, one
 * write-ahead). The row carries `turnId`.
 */
export async function deliverList(
  conversation: Conversation,
  input: { list: InteractiveListSpec; fallbackText: string; origin: MessageOrigin; turnId?: string | null; answers?: string[] }
): Promise<{ message: Message; usedList: boolean }> {
  const row = await writeAhead(conversation, {
    text: input.fallbackText, origin: input.origin, turnId: input.turnId, answers: input.answers, kind: "interactive",
  });
  if (conversation.isTest) return { message: await skipSend(conversation, row), usedList: true };
  const listSend = await sendInteractiveList(conversation.phone, input.list);
  if (listSend.ok) return { message: await afterSend(conversation, row, listSend), usedList: true };
  log.warn({ conversationId: conversation.id, status: listSend.status }, "list send failed, falling back to text");
  // Interakt's reason goes to events, never to logs; failing to record it must not stop the fallback.
  try {
    await recordEvent("list_send_failed", { status: listSend.status, error: listSend.error ?? null }, conversation.id);
  } catch {
    log.warn({ conversationId: conversation.id }, "list_send_failed event not recorded");
  }
  const message = await afterSend(conversation, row, await sendText(conversation.phone, input.fallbackText), "text");
  return { message, usedList: false };
}

/** An Interakt status worth another attempt: no response (network error, timeout), rate limited, or a server error. */
const RETRYABLE_STATUS = sql`(${messages.deliveryHttpStatus} = 0 or ${messages.deliveryHttpStatus} = 429 or ${messages.deliveryHttpStatus} >= 500)`;

/**
 * The resend sweep. A reply to a real conversation that is under 10 minutes old and has had fewer than
 * MAX_DELIVERY_ATTEMPTS attempts is sent again from its stored text when its send failed with a retryable status, or
 * when it was left "sending" for over 2 minutes (a crash or a failed write after the send; its outcome is unknown, so
 * it is treated as failed, at the risk of a duplicate of the same text). The model never runs again, so the reporter
 * never gets a different reply. Each attempt is claimed first (its attempt count must still be the one read) and
 * marked "sending", then the row takes the outcome and an outbound_retry event records the attempt, Interakt's reason
 * included (events only, never logs). One row's failure is logged and the others still go. One worker process runs
 * the sweep; a second one could resend a reply another is still resending. Returns how many replies it tried.
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
        or(
          and(eq(messages.deliveryStatus, "failed"), RETRYABLE_STATUS),
          and(eq(messages.deliveryStatus, "sending"), lt(messages.createdAt, sql`now() - interval '2 minutes'`))
        ),
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
        .set({ deliveryAttempts: attempt, deliveryStatus: "sending" })
        .where(and(eq(messages.id, message.id), eq(messages.deliveryAttempts, message.deliveryAttempts)))
        .returning({ id: messages.id });
      if (!claimed) continue;
      tried += 1;
      const send = await sendText(phone, message.content);
      await recordSendResult(message.id, send, "text");
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
