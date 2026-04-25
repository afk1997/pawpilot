/**
 * Background processor: runs the LLM tool loop after the webhook has
 * already sent the instant ack. Decoupled from the webhook so the LLM
 * latency cannot violate Interakt's 5-second contract.
 *
 * Right now the webhook calls processIncoming directly via setImmediate /
 * Promise without await, which works on Vercel Fluid Compute (functions
 * keep running after the HTTP response is sent up to the function timeout).
 * If we later need durable retries, we can swap this to Vercel Queues
 * without changing call sites.
 */
import { supabase } from "../supabase";
import { sendWhatsAppMessage } from "../whatsapp";
import { audit } from "../audit";
import { runAgentTurn } from "../ai";
import type { Language } from "../types";

const FOLLOWUP_DELAY_MIN = Number(process.env.FOLLOWUP_DELAY_MIN ?? 5);

export interface ProcessIncomingInput {
  conversationId: string;
  inboundMessageId: string;
  reporterPhone: string;
  reporterName: string | null;
  language: Language;
}

/**
 * Run one LLM turn for the conversation, send the response, and update status.
 * Safe to run after the HTTP response has been returned to Interakt.
 */
export async function processIncoming(input: ProcessIncomingInput): Promise<void> {
  // Pull the most recent ~20 messages as conversation history (excluding the
  // instant ack — it's not useful context for the LLM).
  const { data: history } = await supabase
    .from("messages")
    .select("role, content, is_instant_ack, created_at")
    .eq("conversation_id", input.conversationId)
    .order("created_at", { ascending: true })
    .limit(40);

  const filtered = (history ?? [])
    .filter((m) => !m.is_instant_ack)
    .slice(-20)
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content as string }));

  // Determine current conversation status + whether we have a usable location.
  const { data: convo } = await supabase
    .from("conversations")
    .select("status, mode, delivered_ambulance_id")
    .eq("id", input.conversationId)
    .single();

  if (!convo) return;
  if (convo.mode === "human") return; // dispatcher took over while we were waiting

  const hasLocation = await hasUsableLocation(input.conversationId);

  const result = await runAgentTurn({
    conversationId: input.conversationId,
    reporterPhone: input.reporterPhone,
    reporterName: input.reporterName,
    history: filtered,
    language: input.language,
    conversationStatus: convo.status as string,
    hasLocation,
  });

  if (!result.text) return;

  // Send + persist outbound.
  const send = await sendWhatsAppMessage(input.reporterPhone, result.text);
  const inserted = await supabase
    .from("messages")
    .insert({
      conversation_id: input.conversationId,
      role: "assistant",
      content: result.text,
      message_type: "text",
      delivery_status: send.ok ? "sent" : "failed",
      failed_reason: send.ok ? null : (send.error ?? "send failed"),
    })
    .select("id")
    .single();

  await audit({
    conversationId: input.conversationId,
    messageId: inserted.data?.id ?? null,
    actionType: "outbound",
    messageText: result.text,
    metadata: {
      hit_step_cap: result.hitStepCap,
      escalated: result.escalated,
      usage: result.usage ?? null,
    },
  });

  // Status transitions based on what the LLM did this turn.
  await updateStatusAfterTurn(input.conversationId, result.text, result.escalated);

  // If the LLM escalated, ensure the orchestrator-level state matches.
  if (result.escalated) {
    await supabase
      .from("conversations")
      .update({
        mode: "human",
        status: "escalated",
        updated_at: new Date().toISOString(),
      })
      .eq("id", input.conversationId);
  }
}

async function hasUsableLocation(conversationId: string): Promise<boolean> {
  const { data } = await supabase
    .from("messages")
    .select("message_type, content, location_lat")
    .eq("conversation_id", conversationId)
    .eq("role", "user")
    .order("created_at", { ascending: false })
    .limit(20);
  if (!data) return false;
  for (const m of data) {
    if (m.location_lat !== null && m.location_lat !== undefined) return true;
    const txt = (m.content as string) ?? "";
    // Naive heuristic: any message mentioning a likely city/area name is "maybe location";
    // the LLM already handles this better. We just hint to the system prompt.
    if (txt.length > 8 && /[a-zA-Zऀ-ॿ઀-૿]/.test(txt)) return true;
  }
  return false;
}

/**
 * Map LLM output to conversation status. We look for a delivered phone
 * number (any +91XXXXXXXXXX-shaped string in the outbound) and stamp
 * delivered_at + awaiting_followup_at if so.
 */
async function updateStatusAfterTurn(
  conversationId: string,
  outboundText: string,
  escalated: boolean
): Promise<void> {
  if (escalated) return; // escalation path handles its own status

  const phoneInOutput = /\+91[\s-]?\d{4}[\s-]?\d{3}[\s-]?\d{3,4}/.test(outboundText);
  if (phoneInOutput) {
    const followupAt = new Date(Date.now() + FOLLOWUP_DELAY_MIN * 60_000).toISOString();
    await supabase
      .from("conversations")
      .update({
        status: "number_delivered",
        delivered_at: new Date().toISOString(),
        awaiting_followup_at: followupAt,
        updated_at: new Date().toISOString(),
      })
      .eq("id", conversationId);
    return;
  }

  // Otherwise we're still gathering context.
  const { data: convo } = await supabase
    .from("conversations")
    .select("status")
    .eq("id", conversationId)
    .single();
  if (convo?.status === "new") {
    await supabase
      .from("conversations")
      .update({ status: "awaiting_location", updated_at: new Date().toISOString() })
      .eq("id", conversationId);
  }
}
