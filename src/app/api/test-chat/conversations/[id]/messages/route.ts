/**
 * Test-chat messages API.
 *
 * GET  → list all messages in a test conversation (chronological).
 * POST → user types a message; we run the same processing the webhook runs
 *        (welcome on first contact, otherwise processIncoming with the
 *        is_test gate so sendAndPersist persists but doesn't call Interakt).
 *
 * Gated by ENABLE_TEST_CHAT=1.
 */
import { NextRequest, after } from "next/server";
import { randomUUID } from "node:crypto";
import { supabase } from "@/lib/supabase";
import { audit } from "@/lib/audit";
import { detectLanguage } from "@/lib/lang";
import { welcomeMessage } from "@/lib/messages/welcome";
import { processIncoming } from "@/lib/processor/process-incoming";
import type { Language } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function gateOff(): boolean {
  return process.env.ENABLE_TEST_CHAT !== "1";
}

async function loadTestConversation(id: string) {
  const { data } = await supabase
    .from("conversations")
    .select("id, phone, name, mode, status, language, is_test")
    .eq("id", id)
    .maybeSingle();
  if (!data || !data.is_test) return null;
  return data;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (gateOff()) return new Response("not found", { status: 404 });
  const { id } = await params;

  const convo = await loadTestConversation(id);
  if (!convo) return Response.json({ error: "not found" }, { status: 404 });

  const { data: messages, error } = await supabase
    .from("messages")
    .select("*")
    .eq("conversation_id", id)
    .order("created_at", { ascending: true });

  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json(messages ?? []);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (gateOff()) return new Response("not found", { status: 404 });
  const { id } = await params;

  const body = (await request.json().catch(() => ({}))) as { content?: string };
  const content = (body.content ?? "").trim();
  if (!content) {
    return Response.json({ error: "content required" }, { status: 400 });
  }

  const convo = await loadTestConversation(id);
  if (!convo) return Response.json({ error: "not found" }, { status: 404 });

  // Insert the inbound user message — match webhook's shape so the dashboard
  // (if it ever loads this conv directly) and processIncoming see normal data.
  const inboundMessageId = randomUUID();
  const { error: insertError } = await supabase
    .from("messages")
    .insert({
      id: inboundMessageId,
      conversation_id: id,
      role: "user",
      content,
      message_type: "text",
      // No whatsapp_msg_id — it's unique and not relevant for test inputs.
    });
  if (insertError) {
    return Response.json({ error: insertError.message }, { status: 500 });
  }

  // Detect language if not yet set on the conversation.
  const language: Language = ((convo.language as Language | null) ??
    detectLanguage(content)) as Language;

  await supabase
    .from("conversations")
    .update({
      last_inbound_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      // Persist detected language on first message so subsequent replies use it.
      ...(convo.language ? {} : { language }),
    })
    .eq("id", id);

  await audit({
    conversationId: id,
    messageId: inboundMessageId,
    actionType: "inbound",
    messageText: content,
    metadata: { source: "test_chat" },
  });

  // Dispatcher took over — agent is silent. (Test mode shouldn't normally
  // see this state, but the LLM could escalate via the tool.)
  if (convo.mode === "human") {
    return Response.json({ status: "stored_for_human", messageId: inboundMessageId });
  }

  // First-contact welcome — replicates the webhook's welcome branch but
  // skips the WhatsApp send. Persisted so Realtime delivers it to the test UI.
  const isFirstContact = await checkFirstContact(id);
  if (isFirstContact) {
    after(async () => {
      try {
        await persistWelcome(id, language);
      } catch (e) {
        console.error("[test-chat] welcome persist failed:", e);
      }
    });
    return Response.json({ status: "welcome_queued", messageId: inboundMessageId });
  }

  // Normal turn — full processIncoming pipeline with the is_test gate so
  // sendAndPersist persists the assistant message but skips Interakt.
  after(async () => {
    try {
      await processIncoming({
        conversationId: id,
        inboundMessageId,
        inboundText: content,
        reporterPhone: convo.phone as string,
        reporterName: (convo.name as string | null) ?? null,
        language,
        isTest: true,
      });
    } catch (e) {
      console.error("[test-chat] processIncoming failed:", e);
    }
  });

  return Response.json({ status: "queued", messageId: inboundMessageId });
}

async function checkFirstContact(conversationId: string): Promise<boolean> {
  const { data } = await supabase
    .from("messages")
    .select("id")
    .eq("conversation_id", conversationId)
    .eq("role", "assistant")
    .limit(1);
  return !data || data.length === 0;
}

async function persistWelcome(conversationId: string, language: Language) {
  const welcome = welcomeMessage(language);
  const inserted = await supabase
    .from("messages")
    .insert({
      conversation_id: conversationId,
      role: "assistant",
      content: welcome,
      message_type: "text",
      delivery_status: "test_skipped",
    })
    .select("id")
    .single();

  await supabase
    .from("conversations")
    .update({
      status: "awaiting_intent",
      updated_at: new Date().toISOString(),
    })
    .eq("id", conversationId);

  await audit({
    conversationId,
    messageId: inserted.data?.id ?? null,
    actionType: "outbound",
    messageText: welcome,
    metadata: { kind: "welcome", source: "test_chat" },
  });
}
