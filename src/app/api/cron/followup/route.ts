/**
 * Vercel Cron: 5-minute follow-up.
 *
 * Schedule (vercel.json / vercel.ts): every 1 minute.
 *
 * Picks conversations where:
 *   - status = 'number_delivered'
 *   - awaiting_followup_at <= now()
 *
 * Sends the localized "did you connect?" message, transitions to
 * awaiting_followup, audits, and clears awaiting_followup_at so we don't
 * re-send.
 */
import { NextRequest } from "next/server";
import { supabase } from "@/lib/supabase";
import { sendWhatsAppMessage } from "@/lib/whatsapp";
import { audit } from "@/lib/audit";
import { followupMessage } from "@/lib/messages/followup";
import type { Language } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorized(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // dev / sandbox: allow.
  const provided = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  return provided === secret;
}

export async function GET(request: NextRequest) {
  if (!authorized(request)) return new Response("forbidden", { status: 403 });

  const nowIso = new Date().toISOString();
  const { data: due, error } = await supabase
    .from("conversations")
    .select(
      "id, phone, language, delivered_ambulance_id, ambulances:delivered_ambulance_id(label)"
    )
    .eq("status", "number_delivered")
    .lte("awaiting_followup_at", nowIso)
    .limit(50);

  if (error) {
    console.error("followup cron query failed:", error);
    return Response.json({ error: error.message }, { status: 500 });
  }
  if (!due || due.length === 0) {
    return Response.json({ status: "ok", processed: 0 });
  }

  let sent = 0;
  for (const c of due) {
    const language = ((c.language as Language | null) ?? "en") as Language;
    const driverLabel =
      (c as unknown as { ambulances?: { label?: string } }).ambulances?.label ?? null;

    const text = followupMessage(language, driverLabel);
    const send = await sendWhatsAppMessage(c.phone as string, text);

    const inserted = await supabase
      .from("messages")
      .insert({
        conversation_id: c.id,
        role: "assistant",
        content: text,
        message_type: "text",
        delivery_status: send.ok ? "sent" : "failed",
        failed_reason: send.ok ? null : (send.error ?? "send failed"),
      })
      .select("id")
      .single();

    await supabase
      .from("conversations")
      .update({
        status: "awaiting_followup",
        awaiting_followup_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", c.id);

    await audit({
      conversationId: c.id as string,
      messageId: inserted.data?.id ?? null,
      actionType: "followup_sent",
      messageText: text,
      metadata: { driver_label: driverLabel },
    });

    sent++;
  }

  return Response.json({ status: "ok", processed: sent });
}
