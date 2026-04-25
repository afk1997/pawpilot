/**
 * Interakt webhook endpoint — public entry point for inbound WhatsApp
 * messages from reporters.
 *
 * Hard contract:
 *  - Return 200 within 5 seconds (Interakt retries otherwise).
 *  - Send the instant ack BEFORE running any LLM. Reporter never waits.
 *  - Idempotent: dedup by Interakt's message id.
 *  - Audit every step.
 *
 * NOTE: Phase 1 sends a static instant ack only. Phase 2 plugs in the
 * tool-using LLM in a background processor.
 */
import { NextRequest, after } from "next/server";
import { supabase } from "@/lib/supabase";
import { sendWhatsAppMessage } from "@/lib/whatsapp";
import { parseInteraktPayload, verifyInteraktSignature } from "@/lib/interakt-webhook";
import { audit } from "@/lib/audit";
import { detectLanguage, isCannotReachMessage, isHumanHandoffRequest } from "@/lib/lang";
import { instantAck } from "@/lib/instant-ack";
import { processIncoming } from "@/lib/processor/process-incoming";
import type { Language } from "@/lib/types";

export const runtime = "nodejs";
// Don't try to cache or pre-render this route.
export const dynamic = "force-dynamic";

/** Health/probe endpoint. Interakt does not use a Meta-style GET handshake. */
export async function GET() {
  return new Response("ok", { status: 200 });
}

export async function POST(request: NextRequest) {
  // Read raw body once for signature verification, then parse.
  const rawBody = await request.text();

  const verified = await verifyInteraktSignature(rawBody, request.headers);
  if (!verified) {
    return new Response("forbidden", { status: 403 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return Response.json({ status: "bad_json" }, { status: 400 });
  }

  const incoming = parseInteraktPayload(payload);
  if (!incoming) {
    return Response.json({ status: "ignored_event" });
  }

  // Idempotency — if we've already processed this providerMessageId, bail.
  const dedup = await supabase
    .from("messages")
    .select("id")
    .eq("whatsapp_msg_id", incoming.providerMessageId)
    .maybeSingle();
  if (dedup.data) {
    return Response.json({ status: "duplicate" });
  }

  // Find or create conversation by phone.
  type ConvoLite = {
    id: string;
    phone: string;
    name: string | null;
    mode: "agent" | "human";
    status: string;
    language: Language | null;
  };

  const conversation: ConvoLite | null = await (async (): Promise<ConvoLite | null> => {
    const existing = await supabase
      .from("conversations")
      .select("id, phone, name, mode, status, language")
      .eq("phone", incoming.fromPhone)
      .maybeSingle();

    if (existing.data) {
      if (incoming.fromName && incoming.fromName !== existing.data.name) {
        await supabase
          .from("conversations")
          .update({ name: incoming.fromName })
          .eq("id", existing.data.id);
      }
      return existing.data as ConvoLite;
    }

    const language = detectLanguage(incoming.text);
    const created = await supabase
      .from("conversations")
      .insert({
        phone: incoming.fromPhone,
        name: incoming.fromName,
        status: "new",
        language,
      })
      .select("id, phone, name, mode, status, language")
      .single();
    if (created.error || !created.data) {
      console.error("Failed to create conversation:", created.error);
      return null;
    }
    return created.data as ConvoLite;
  })();

  if (!conversation) {
    return Response.json({ status: "error" }, { status: 500 });
  }

  // Persist inbound message.
  const inboundInsert = await supabase
    .from("messages")
    .insert({
      conversation_id: conversation.id,
      role: "user",
      content: incoming.text,
      whatsapp_msg_id: incoming.providerMessageId,
      message_type: incoming.type,
      media_url: incoming.mediaUrl,
      location_lat: incoming.locationLat,
      location_lng: incoming.locationLng,
    })
    .select("id")
    .single();

  // 23505 = unique-violation; treat as duplicate.
  if (inboundInsert.error?.code === "23505") {
    return Response.json({ status: "duplicate" });
  }
  if (inboundInsert.error || !inboundInsert.data) {
    console.error("Failed to insert inbound message:", inboundInsert.error);
    return Response.json({ status: "error" }, { status: 500 });
  }
  const inboundMessageId = inboundInsert.data.id;

  await audit({
    conversationId: conversation.id,
    messageId: inboundMessageId,
    actionType: "inbound",
    messageText: incoming.text,
    metadata: {
      type: incoming.type,
      hasMedia: !!incoming.mediaUrl,
      hasLocation: incoming.locationLat !== null,
    },
  });

  await supabase
    .from("conversations")
    .update({ last_inbound_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", conversation.id);

  // If conversation is in human mode, do not auto-reply.
  if (conversation.mode === "human") {
    return Response.json({ status: "stored_for_human" });
  }

  const language: Language = (conversation.language ?? detectLanguage(incoming.text)) as Language;
  const isVoiceNote = incoming.type === "audio";

  // Send the instant ack synchronously — must reach the reporter quickly.
  // Phase 2 will move this into a background processor along with the LLM call.
  const ackText = instantAck(language, isVoiceNote);
  await sendWhatsAppMessage(incoming.fromPhone, ackText);

  const ackInsert = await supabase
    .from("messages")
    .insert({
      conversation_id: conversation.id,
      role: "assistant",
      content: ackText,
      message_type: "text",
      is_instant_ack: true,
      delivery_status: "sent",
    })
    .select("id")
    .single();

  await audit({
    conversationId: conversation.id,
    messageId: ackInsert.data?.id ?? null,
    actionType: "instant_ack",
    messageText: ackText,
  });

  // Hardcoded rails — narrow auto-escalation paths.
  let escalatedThisTurn = false;
  if (
    conversation.status === "number_delivered" ||
    conversation.status === "awaiting_followup"
  ) {
    if (isCannotReachMessage(incoming.text)) {
      await escalate(conversation.id, "cannot_reach_driver", incoming.text, language);
      escalatedThisTurn = true;
    }
  }
  if (!escalatedThisTurn && isHumanHandoffRequest(incoming.text)) {
    await escalate(conversation.id, "manual_human_request", incoming.text, language);
    escalatedThisTurn = true;
  }

  // Kick off the LLM tool loop in the background. `after()` schedules work
  // to run after this response has been sent to Interakt — keeps us inside
  // the 5-second contract regardless of LLM latency.
  if (!escalatedThisTurn) {
    after(async () => {
      try {
        await processIncoming({
          conversationId: conversation.id,
          inboundMessageId,
          reporterPhone: incoming.fromPhone,
          reporterName: incoming.fromName,
          language,
        });
      } catch (e) {
        console.error("background processIncoming failed:", e);
      }
    });
  }

  return Response.json({ status: "ack_sent" });
}

async function escalate(
  conversationId: string,
  reason: string,
  inboundText: string,
  language: Language
) {
  const FEEDBACK_REGISTERED: Record<Language, string> = {
    en: "Thanks, your feedback is registered. Our team will take action shortly.",
    hi: "धन्यवाद, आपकी प्रतिक्रिया दर्ज हो गई है। हमारी टीम जल्द ही कार्रवाई करेगी।",
    mr: "धन्यवाद, तुमचा अभिप्राय नोंदवला आहे. आमची टीम लवकरच कारवाई करेल.",
    gu: "આભાર, તમારો પ્રતિસાદ નોંધવામાં આવ્યો છે. અમારી ટીમ ટૂંક સમયમાં કાર્યવાહી કરશે.",
  };

  // Switch conversation to human mode + escalated status.
  await supabase
    .from("conversations")
    .update({
      mode: "human",
      status: "escalated",
      escalation_reason: reason,
      updated_at: new Date().toISOString(),
    })
    .eq("id", conversationId);

  // Send acknowledgment if reason is cannot_reach (per design rule).
  if (reason === "cannot_reach_driver") {
    const { data: convo } = await supabase
      .from("conversations")
      .select("phone")
      .eq("id", conversationId)
      .single();
    if (convo) {
      const ackText = FEEDBACK_REGISTERED[language] ?? FEEDBACK_REGISTERED.en;
      await sendWhatsAppMessage(convo.phone, ackText);
      const inserted = await supabase
        .from("messages")
        .insert({
          conversation_id: conversationId,
          role: "assistant",
          content: ackText,
          message_type: "text",
          delivery_status: "sent",
        })
        .select("id")
        .single();
      await audit({
        conversationId,
        messageId: inserted.data?.id ?? null,
        actionType: "outbound",
        messageText: ackText,
        metadata: { triggered_by: "cannot_reach_acknowledgment" },
      });
    }
  }

  await audit({
    conversationId,
    actionType: "escalation",
    messageText: inboundText,
    metadata: { reason },
  });
}
