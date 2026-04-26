/**
 * Interakt webhook endpoint — public entry point for inbound WhatsApp
 * messages from reporters.
 *
 * Hard contract:
 *  - Return 200 within 3 seconds (Interakt's spec). LLM runs in `after()`.
 *  - Send the instant ack BEFORE running any LLM. Reporter never waits.
 *  - Idempotent: dedup by Interakt's message id.
 *  - Audit every step.
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

  // Debug: capture Interakt's exact wire format. Truncated to 4KB.
  // Toggle off via INTERAKT_DEBUG_LOG=0 once we've confirmed the parser.
  if (process.env.INTERAKT_DEBUG_LOG !== "0") {
    const sigHeader =
      request.headers.get("interakt-signature") ??
      request.headers.get("x-interakt-signature") ??
      "(none)";
    console.log("[webhook] inbound", {
      sig: sigHeader.slice(0, 32) + "...",
      bodyPreview: rawBody.slice(0, 4096),
    });
  }

  const verified = await verifyInteraktSignature(rawBody, request.headers);
  if (!verified) {
    console.warn("[webhook] signature verification failed");
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
    const eventType =
      typeof payload === "object" && payload !== null
        ? (payload as { type?: string }).type ?? "(no type)"
        : "(non-object)";
    console.log("[webhook] ignored event:", eventType);
    return Response.json({ status: "ignored_event", event_type: eventType });
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

  // Find or create conversation by phone. We use upsert with onConflict to
  // close a race window where two webhooks for a brand-new reporter arrive
  // in parallel — both would otherwise pass an empty `existing` check, both
  // would INSERT, and the second would fail with a unique violation,
  // returning 500 to Interakt and triggering its retry behaviour.
  type ConvoLite = {
    id: string;
    phone: string;
    name: string | null;
    mode: "agent" | "human";
    status: string;
    language: Language | null;
  };

  const conversation: ConvoLite | null = await (async (): Promise<ConvoLite | null> => {
    const language = detectLanguage(incoming.text);

    // Upsert by phone. ignoreDuplicates=false means returning the existing
    // row instead of failing; we then update name if we just learned it.
    const upserted = await supabase
      .from("conversations")
      .upsert(
        {
          phone: incoming.fromPhone,
          name: incoming.fromName,
          status: "new",
          language,
        },
        { onConflict: "phone", ignoreDuplicates: true }
      )
      .select("id, phone, name, mode, status, language")
      .maybeSingle();

    if (upserted.data) {
      if (incoming.fromName && incoming.fromName !== upserted.data.name) {
        await supabase
          .from("conversations")
          .update({ name: incoming.fromName })
          .eq("id", upserted.data.id);
      }
      return upserted.data as ConvoLite;
    }

    // ignoreDuplicates returned no row when a duplicate existed; fetch it.
    const existing = await supabase
      .from("conversations")
      .select("id, phone, name, mode, status, language")
      .eq("phone", incoming.fromPhone)
      .maybeSingle();
    if (existing.data) return existing.data as ConvoLite;

    console.error("Failed to upsert conversation:", upserted.error);
    return null;
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

  // Decide which path we're on BEFORE sending anything outbound. The
  // hardcoded escalation paths (cannot-reach, human-handoff) get a single
  // localized "feedback registered" / handoff acknowledgement — NOT the
  // generic instant ack. Sending both would mean the reporter gets two
  // messages back-to-back, which is confusing.
  let escalatedThisTurn = false;
  let escalationReason: string | null = null;
  if (
    conversation.status === "number_delivered" ||
    conversation.status === "awaiting_followup"
  ) {
    if (isCannotReachMessage(incoming.text)) {
      escalationReason = "cannot_reach_driver";
      escalatedThisTurn = true;
    }
  }
  if (!escalatedThisTurn && isHumanHandoffRequest(incoming.text)) {
    escalationReason = "manual_human_request";
    escalatedThisTurn = true;
  }

  if (escalatedThisTurn && escalationReason) {
    // Send single localized ack (synchronously, so it reaches the reporter
    // immediately) then defer all DB / audit writes to after().
    const reason = escalationReason;
    const ackText =
      reason === "cannot_reach_driver"
        ? FEEDBACK_REGISTERED[language] ?? FEEDBACK_REGISTERED.en
        : HANDOFF_ACK[language] ?? HANDOFF_ACK.en;
    await sendWhatsAppMessage(incoming.fromPhone, ackText);
    after(async () => {
      try {
        await escalate(conversation.id, reason, incoming.text, ackText);
      } catch (e) {
        console.error("background escalate failed:", e);
      }
    });
  } else {
    // Normal path — send the generic instant ack synchronously, then run
    // the LLM tool loop in `after()`.
    const ackText = instantAck(language, isVoiceNote);
    await sendWhatsAppMessage(incoming.fromPhone, ackText);

    after(async () => {
      try {
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
        await processIncoming({
          conversationId: conversation.id,
          inboundMessageId,
          inboundText: incoming.text,
          reporterPhone: incoming.fromPhone,
          reporterName: incoming.fromName,
          language,
        });
      } catch (e) {
        console.error("background work failed:", e);
      }
    });
  }

  return Response.json({ status: "ack_sent" });
}

// Localized escalation acknowledgements.
const FEEDBACK_REGISTERED: Record<Language, string> = {
  en: "Thanks, your feedback is registered. Our team will take action shortly.",
  hi: "धन्यवाद, आपकी प्रतिक्रिया दर्ज हो गई है। हमारी टीम जल्द ही कार्रवाई करेगी।",
  mr: "धन्यवाद, तुमचा अभिप्राय नोंदवला आहे. आमची टीम लवकरच कारवाई करेल.",
  gu: "આભાર, તમારો પ્રતિસાદ નોંધવામાં આવ્યો છે. અમારી ટીમ ટૂંક સમયમાં કાર્યવાહી કરશે.",
};

const HANDOFF_ACK: Record<Language, string> = {
  en: "Got it — connecting you with a team member. They'll reply here shortly.",
  hi: "ठीक है — आपको हमारी टीम के सदस्य से जोड़ रहे हैं। वे जल्द ही यहाँ जवाब देंगे।",
  mr: "ठीक आहे — तुम्हाला आमच्या टीममधील एका सदस्याशी जोडत आहोत. ते लवकरच इथे उत्तर देतील.",
  gu: "ઠીક છે — તમને અમારી ટીમના સભ્ય સાથે જોડી રહ્યા છીએ. તેઓ ટૂંક સમયમાં અહીં જવાબ આપશે.",
};

/**
 * Background-only: persist the escalation state + audit. The user-visible
 * ack message has already been sent synchronously by the caller. Keep this
 * out of the 3-second webhook critical path.
 */
async function escalate(
  conversationId: string,
  reason: string,
  inboundText: string,
  ackTextSent: string
) {
  await supabase
    .from("conversations")
    .update({
      mode: "human",
      status: "escalated",
      escalation_reason: reason,
      updated_at: new Date().toISOString(),
    })
    .eq("id", conversationId);

  // Persist the ack we sent synchronously, so it's in the conversation history.
  const inserted = await supabase
    .from("messages")
    .insert({
      conversation_id: conversationId,
      role: "assistant",
      content: ackTextSent,
      message_type: "text",
      delivery_status: "sent",
    })
    .select("id")
    .single();

  await audit({
    conversationId,
    messageId: inserted.data?.id ?? null,
    actionType: "outbound",
    messageText: ackTextSent,
    metadata: { triggered_by: reason },
  });

  await audit({
    conversationId,
    actionType: "escalation",
    messageText: inboundText,
    metadata: { reason, source: "rail" },
  });
}
