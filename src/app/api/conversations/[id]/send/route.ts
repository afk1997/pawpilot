import { NextRequest } from "next/server";
import { supabase } from "@/lib/supabase";
import { sendWhatsAppMessage } from "@/lib/whatsapp";
import { audit } from "@/lib/audit";

/**
 * Manual send from the dispatcher dashboard. Used when the dispatcher takes
 * over a conversation and types a reply themselves. Records `dispatcher_send`
 * in the audit log so we can distinguish human vs agent messages later.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await request.json();
  const { message, dispatcher } = body as { message?: string; dispatcher?: string };

  if (!message?.trim()) {
    return Response.json({ error: "Message is required" }, { status: 400 });
  }

  const { data: conversation, error: convoError } = await supabase
    .from("conversations")
    .select("id, phone, mode, is_test")
    .eq("id", id)
    .single();

  if (convoError || !conversation) {
    return Response.json({ error: "Conversation not found" }, { status: 404 });
  }
  // Dispatcher MUST NEVER manually send to a test conversation — that would
  // route to the synthetic +91TEST_* phone via Interakt.
  if (conversation.is_test) {
    return Response.json({ error: "Conversation not found" }, { status: 404 });
  }

  const sendResult = await sendWhatsAppMessage(conversation.phone, message);
  if (!sendResult.ok) {
    return Response.json(
      { error: "WhatsApp send failed", details: sendResult.error ?? sendResult.body },
      { status: 502 }
    );
  }

  const { data: msg, error: msgError } = await supabase
    .from("messages")
    .insert({
      conversation_id: id,
      role: "assistant",
      content: message,
      message_type: "text",
      delivery_status: "sent",
    })
    .select()
    .single();

  if (msgError) {
    return Response.json({ error: msgError.message }, { status: 500 });
  }

  await supabase
    .from("conversations")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", id);

  await audit({
    conversationId: id,
    messageId: msg.id,
    actionType: "dispatcher_send",
    messageText: message,
    actor: dispatcher ?? "dispatcher",
  });

  return Response.json(msg);
}
