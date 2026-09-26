import { getDb } from "../db/client";
import { messages, type Conversation, type Message } from "../db/schema";
import { sendInteractiveList, sendText, type InteractiveListSpec, type InteraktResult } from "../interakt/client";
import { recordEvent, stripNul, stripNulOrNull } from "../inbound/store";
import { flagConversation, updateConversation } from "./persist";
import type { MessageOrigin } from "../types";
import { log } from "../log";

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
      error: send && !send.ok ? send.error ?? `status=${send.status}` : null,
      turnId: input.turnId ?? null,
    })
    .returning();
  await updateConversation(conversation.id, { lastOutboundAt: new Date() });
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
