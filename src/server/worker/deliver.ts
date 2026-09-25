import { getDb } from "../db/client";
import { messages, type Conversation, type Message } from "../db/schema";
import { sendInteractiveList, sendText, type InteractiveListSpec, type InteraktResult } from "../interakt/client";
import { updateConversation } from "./persist";
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
      content: input.text,
      contentTemplate: input.template ?? null,
      providerMessageId: send?.messageId ? `out:${send.messageId}` : null,
      deliveryStatus: send === null ? "test_skipped" : send.ok ? "sent" : "failed",
      error: send && !send.ok ? send.error ?? `status=${send.status}` : null,
      // input.turnId is accepted but not stored yet: Task 21 adds messages.turn_id and stores it here.
    })
    .returning();
  await updateConversation(conversation.id, { lastOutboundAt: new Date() });
  return row;
}

/** Sends free-form text (skipped for test conversations) and persists the assistant message. */
export async function deliverText(
  conversation: Conversation,
  input: { text: string; template?: string | null; origin: MessageOrigin; turnId?: string | null }
): Promise<Message> {
  const send = conversation.isTest ? null : await sendText(conversation.phone, input.text);
  if (send && !send.ok) log.warn({ conversationId: conversation.id, error: send.error }, "outbound failed");
  return persistOutbound(conversation, input, send);
}

/** Sends a WhatsApp list; falls back to plain text when the list is rejected. */
export async function deliverList(
  conversation: Conversation,
  input: { list: InteractiveListSpec; fallbackText: string; origin: MessageOrigin }
): Promise<{ message: Message; usedList: boolean }> {
  if (conversation.isTest) {
    const message = await persistOutbound(conversation, { text: input.fallbackText, origin: input.origin, kind: "interactive" }, null);
    return { message, usedList: true };
  }
  const listSend = await sendInteractiveList(conversation.phone, input.list);
  if (listSend.ok) {
    const message = await persistOutbound(conversation, { text: input.fallbackText, origin: input.origin, kind: "interactive" }, listSend);
    return { message, usedList: true };
  }
  log.warn({ conversationId: conversation.id, error: listSend.error }, "list send failed, falling back to text");
  const textSend = await sendText(conversation.phone, input.fallbackText);
  const message = await persistOutbound(conversation, { text: input.fallbackText, origin: input.origin }, textSend);
  return { message, usedList: false };
}
