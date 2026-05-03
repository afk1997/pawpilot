/**
 * Background processor: runs after the webhook returns 200 to Interakt.
 *
 * Answer Engine architecture:
 *   - Keep the webhook/dashboard shell: conversation lock, persistence,
 *     Interakt send abstraction, status updates, and audit trail.
 *   - Replace the inner turn with workbook-backed evidence retrieval,
 *     deterministic high-stakes responses, and outbound validation.
 *   - LLM composition is intentionally no longer the production source of
 *     factual answers; Supabase KB rows and directory rows are.
 */
import { supabase } from "../supabase";
import { sendWhatsAppMessage } from "../whatsapp";
import { audit } from "../audit";
import { menuMessage } from "../messages/welcome";
import { withConversationLock } from "../conversation-lock";
import type { Language } from "../types";
import { runAnswerEngineTurn, type AnswerEngineTurnResult } from "../answer-engine/run-answer-engine";
import { logAnswerEvent } from "../answer-engine/answer-events";

const FOLLOWUP_DELAY_MIN = Number(process.env.FOLLOWUP_DELAY_MIN ?? 5);

export interface ProcessIncomingInput {
  conversationId: string;
  inboundMessageId: string;
  /** The just-arrived inbound text — passed in so we don't depend on Supabase
   *  read replicas catching up before we run the LLM turn. */
  inboundText: string;
  reporterPhone: string;
  reporterName: string | null;
  language: Language;
  /** When true, sendAndPersist persists the assistant message but does NOT
   *  call Interakt. Used by the /test-chat harness (synthetic +91TEST_*
   *  conversations). Bound to conversations.is_test by the caller. */
  isTest?: boolean;
}

export async function processIncoming(input: ProcessIncomingInput): Promise<void> {
  // Per-conversation lock: serialize parallel inbounds so two messages
  // milliseconds apart don't produce contradictory replies. The lock is
  // released automatically when the inner function returns.
  await withConversationLock(input.conversationId, async () => {
    await processIncomingLocked(input);
  });
}

async function processIncomingLocked(input: ProcessIncomingInput): Promise<void> {
  // Load current conversation status.
  const { data: convo } = await supabase
    .from("conversations")
    .select("status, mode, delivered_ambulance_id")
    .eq("id", input.conversationId)
    .single();
  if (!convo) return;
  if (convo.mode === "human") return;

  // Cheap shortcut — explicit "menu" keyword re-displays the menu without
  // burning an LLM call. This isn't intent detection; it's a UI affordance.
  if (isMenuRequest(input.inboundText)) {
    await sendAndPersist(input, menuMessage(input.language), { kind: "menu_redisplay" });
    return;
  }

  const result = await runAnswerEngineTurn({
    conversationId: input.conversationId,
    inboundMessageId: input.inboundMessageId,
    inboundText: input.inboundText,
    reporterPhone: input.reporterPhone,
    reporterName: input.reporterName,
    language: input.language,
  });

  const persisted = await sendAndPersist(input, result.text, {
    answer_engine: true,
    intent: result.intent,
    confidence: result.confidence,
    validation: result.validation,
    escalated: result.escalated ?? false,
    ...result.metadata,
  });
  await logAnswerEvent({
    conversationId: input.conversationId,
    inboundMessageId: input.inboundMessageId,
    outboundMessageId: persisted.messageId,
    result,
    deliveryStatus: persisted.deliveryStatus,
  });
  await updateStatusAfterAnswer(input.conversationId, result);
}

interface PersistedOutbound {
  messageId: string | null;
  deliveryStatus: string | null;
}

async function sendAndPersist(
  input: ProcessIncomingInput,
  text: string,
  metadata: Record<string, unknown> = {}
): Promise<PersistedOutbound> {
  if (process.env.INTERAKT_DEBUG_LOG !== "0") {
    console.log(
      `[processor] ${input.isTest ? "(test) skipping send to" : "sending to"} ${input.reporterPhone} (${text.length} chars) meta=${JSON.stringify(metadata)}`
    );
  }
  const send = input.isTest
    ? { ok: true, status: 0, body: null, error: null }
    : await sendWhatsAppMessage(input.reporterPhone, text);
  if (!input.isTest && process.env.INTERAKT_DEBUG_LOG !== "0") {
    console.log(
      `[processor] send result ok=${send.ok} status=${send.status} error=${send.error ?? "none"}`
    );
  }
  const inserted = await supabase
    .from("messages")
    .insert({
      conversation_id: input.conversationId,
      role: "assistant",
      content: text,
      message_type: "text",
      delivery_status: input.isTest ? "test_skipped" : (send.ok ? "sent" : "failed"),
      failed_reason: input.isTest || send.ok
        ? null
        : `status=${send.status} body=${JSON.stringify(send.body).slice(0, 200)}`,
    })
    .select("id")
    .single();

  await audit({
    conversationId: input.conversationId,
    messageId: inserted.data?.id ?? null,
    actionType: "outbound",
    messageText: text,
    metadata,
  });
  return {
    messageId: inserted.data?.id ?? null,
    deliveryStatus: input.isTest ? "test_skipped" : (send.ok ? "sent" : "failed"),
  };
}

function isMenuRequest(text: string): boolean {
  if (!text) return false;
  const t = text.trim().toLowerCase();
  return /^(menu|options?|help|sahaay|मेन्यू|पर्याय|मेनू|menyu|મેનુ)$/.test(t);
}

async function updateStatusAfterAnswer(
  conversationId: string,
  result: AnswerEngineTurnResult
): Promise<void> {
  if (result.deliveredAmbulanceId) {
    const followupAt = new Date(Date.now() + FOLLOWUP_DELAY_MIN * 60_000).toISOString();
    await supabase
      .from("conversations")
      .update({
        status: "number_delivered",
        delivered_ambulance_id: result.deliveredAmbulanceId,
        delivered_at: new Date().toISOString(),
        awaiting_followup_at: followupAt,
        updated_at: new Date().toISOString(),
      })
      .eq("id", conversationId);
    return;
  }

  if (result.escalated) return;

  const { data: convo } = await supabase
    .from("conversations")
    .select("status")
    .eq("id", conversationId)
    .single();
  if (convo?.status !== "new" && convo?.status !== "awaiting_intent") return;

  const nextStatus =
    result.intent === "emergency"
      ? result.metadata?.matchCount === 0
        ? "out_of_coverage"
        : "awaiting_location"
      : convo.status;
  await supabase
    .from("conversations")
    .update({
      status: nextStatus,
      updated_at: new Date().toISOString(),
    })
    .eq("id", conversationId);
}
