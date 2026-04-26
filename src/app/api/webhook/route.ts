/**
 * Interakt webhook endpoint — public entry point for inbound WhatsApp
 * messages from reporters.
 *
 * Hard contract:
 *  - Return 200 within 3 seconds (Interakt's spec). LLM runs in `after()`.
 *  - On first contact (no prior assistant messages), send the deterministic
 *    welcome + menu synchronously. Skip the LLM that turn.
 *  - On all subsequent turns, do background LLM processing only — no
 *    pre-LLM ack message (those caused the duplicate-message UX bug).
 *  - Idempotent: dedup by Interakt's message id.
 *  - Audit every step.
 */
import { NextRequest, after } from "next/server";
import { supabase } from "@/lib/supabase";
import { sendWhatsAppMessage } from "@/lib/whatsapp";
import { parseInteraktPayload, verifyInteraktSignature } from "@/lib/interakt-webhook";
import { audit } from "@/lib/audit";
import { detectLanguage, isCannotReachMessage, isHumanHandoffRequest } from "@/lib/lang";
import { welcomeMessage } from "@/lib/messages/welcome";
import { processIncoming } from "@/lib/processor/process-incoming";
import type { Language } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Health/probe endpoint. Interakt does not use a Meta-style GET handshake. */
export async function GET() {
  return new Response("ok", { status: 200 });
}

export async function POST(request: NextRequest) {
  const rawBody = await request.text();

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

  // Idempotency.
  const dedup = await supabase
    .from("messages")
    .select("id")
    .eq("whatsapp_msg_id", incoming.providerMessageId)
    .maybeSingle();
  if (dedup.data) {
    return Response.json({ status: "duplicate" });
  }

  // Find or create conversation by phone (upsert closes the new-reporter race).
  type ConvoLite = {
    id: string;
    phone: string;
    name: string | null;
    mode: "agent" | "human";
    status: string;
    language: Language | null;
    is_test: boolean;
  };

  const conversation: ConvoLite | null = await (async (): Promise<ConvoLite | null> => {
    const language = detectLanguage(incoming.text);
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
      .select("id, phone, name, mode, status, language, is_test")
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

    const existing = await supabase
      .from("conversations")
      .select("id, phone, name, mode, status, language, is_test")
      .eq("phone", incoming.fromPhone)
      .maybeSingle();
    if (existing.data) return existing.data as ConvoLite;

    console.error("Failed to upsert conversation:", upserted.error);
    return null;
  })();

  if (!conversation) {
    return Response.json({ status: "error" }, { status: 500 });
  }

  // Defense in depth: real Interakt phones never use the +91TEST_* prefix
  // that the test harness generates, but if a phone collision somehow
  // happens we refuse to process — would otherwise corrupt test data.
  if (conversation.is_test) {
    console.error("[webhook] phone collision with test conversation:", incoming.fromPhone);
    return Response.json({ status: "ignored_test_conv" });
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

  // Dispatcher took over — agent is silent.
  if (conversation.mode === "human") {
    return Response.json({ status: "stored_for_human" });
  }

  const language: Language = (conversation.language ?? detectLanguage(incoming.text)) as Language;

  // ── First-contact branch ────────────────────────────────────────────────
  // If this conversation has no prior assistant messages at all, send the
  // deterministic welcome + menu and skip the LLM. This is the only synchronous
  // outbound path; everything else runs in background.
  const isFirstContact = await checkFirstContact(conversation.id);
  if (isFirstContact) {
    const welcome = welcomeMessage(language);
    const send = await sendWhatsAppMessage(incoming.fromPhone, welcome);

    after(async () => {
      try {
        const inserted = await supabase
          .from("messages")
          .insert({
            conversation_id: conversation.id,
            role: "assistant",
            content: welcome,
            message_type: "text",
            delivery_status: send.ok ? "sent" : "failed",
          })
          .select("id")
          .single();
        await supabase
          .from("conversations")
          .update({ status: "awaiting_intent", updated_at: new Date().toISOString() })
          .eq("id", conversation.id);
        await audit({
          conversationId: conversation.id,
          messageId: inserted.data?.id ?? null,
          actionType: "outbound",
          messageText: welcome,
          metadata: { kind: "welcome" },
        });
      } catch (e) {
        console.error("background welcome-persist failed:", e);
      }
    });

    return Response.json({ status: "welcome_sent" });
  }

  // ── Hardcoded escalation rails ──────────────────────────────────────────
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
    return Response.json({ status: "escalated" });
  }

  // ── Normal turn — LLM processes in background ──────────────────────────
  // No pre-LLM filler ack. Webhook returns 200 immediately; the LLM call
  // runs in `after()` and its response is the only outbound for this turn.
  after(async () => {
    try {
      await processIncoming({
        conversationId: conversation.id,
        inboundMessageId,
        inboundText: incoming.text,
        reporterPhone: incoming.fromPhone,
        reporterName: incoming.fromName,
        language,
      });
    } catch (e) {
      console.error("background processIncoming failed:", e);
    }
  });

  return Response.json({ status: "queued" });
}

/**
 * True if the conversation has no assistant messages at all yet (i.e. this is
 * the very first inbound and we've never replied). Welcomes only fire on
 * first contact.
 */
async function checkFirstContact(conversationId: string): Promise<boolean> {
  const { data } = await supabase
    .from("messages")
    .select("id")
    .eq("conversation_id", conversationId)
    .eq("role", "assistant")
    .limit(1);
  return !data || data.length === 0;
}

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
