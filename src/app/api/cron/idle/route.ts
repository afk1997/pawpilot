/**
 * Vercel Cron: idle-conversation cleanup.
 *
 * Schedule: every 30 minutes.
 *
 * Sends one gentle nudge to conversations stuck in `awaiting_location` for
 * >30 minutes; closes conversations stuck in any non-terminal status with
 * no reporter activity for >24 hours. Avoids dispatcher dashboard
 * accumulating stale rows at 200–1000/day volume.
 */
import { NextRequest } from "next/server";
import { supabase } from "@/lib/supabase";
import { sendWhatsAppMessage } from "@/lib/whatsapp";
import { audit } from "@/lib/audit";
import type { Language } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NUDGE_AFTER_MS = 30 * 60 * 1000;
const AUTO_CLOSE_AFTER_MS = 24 * 60 * 60 * 1000;

function authorized(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const provided = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  return provided === secret;
}

const NUDGE_BY_LANG: Record<Language, string> = {
  en: "Are you still there? If you have an injured animal to report, please share your area or a WhatsApp location pin.",
  hi: "क्या आप अभी भी हैं? अगर आपको कोई घायल जानवर रिपोर्ट करना है, तो कृपया अपना इलाका या WhatsApp लोकेशन पिन भेजें।",
  mr: "तुम्ही अजून आहात का? जर तुम्हाला एखादा जखमी प्राणी रिपोर्ट करायचा असेल, तर कृपया तुमचा भाग किंवा WhatsApp लोकेशन पिन पाठवा.",
  gu: "શું તમે હજુ છો? જો તમારી પાસે ઇજાગ્રસ્ત પ્રાણીની માહિતી હોય, તો કૃપા કરીને તમારો વિસ્તાર અથવા WhatsApp લોકેશન પિન મોકલો.",
};

export async function GET(request: NextRequest) {
  if (!authorized(request)) return new Response("forbidden", { status: 403 });

  const now = Date.now();
  const nudgeBefore = new Date(now - NUDGE_AFTER_MS).toISOString();
  const closeBefore = new Date(now - AUTO_CLOSE_AFTER_MS).toISOString();

  // 1. Nudge conversations stuck in awaiting_location.
  const { data: stuck } = await supabase
    .from("conversations")
    .select("id, phone, language, last_inbound_at")
    .eq("status", "awaiting_location")
    .lte("last_inbound_at", nudgeBefore)
    .limit(50);

  let nudged = 0;
  for (const c of stuck ?? []) {
    const language = ((c.language as Language | null) ?? "en") as Language;
    const text = NUDGE_BY_LANG[language] ?? NUDGE_BY_LANG.en;
    const send = await sendWhatsAppMessage(c.phone as string, text);
    const inserted = await supabase
      .from("messages")
      .insert({
        conversation_id: c.id,
        role: "assistant",
        content: text,
        message_type: "text",
        delivery_status: send.ok ? "sent" : "failed",
      })
      .select("id")
      .single();
    await audit({
      conversationId: c.id as string,
      messageId: inserted.data?.id ?? null,
      actionType: "outbound",
      messageText: text,
      metadata: { reason: "idle_nudge" },
    });
    // Bump status so we don't nudge again.
    await supabase
      .from("conversations")
      .update({ status: "closed", updated_at: new Date().toISOString() })
      .eq("id", c.id);
    nudged++;
  }

  // 2. Auto-close stale conversations in any non-terminal status.
  const { data: stale } = await supabase
    .from("conversations")
    .select("id")
    .not("status", "in", "(closed,escalated)")
    .lte("last_inbound_at", closeBefore)
    .limit(200);

  let closed = 0;
  for (const c of stale ?? []) {
    await supabase
      .from("conversations")
      .update({ status: "closed", updated_at: new Date().toISOString() })
      .eq("id", c.id);
    await audit({
      conversationId: c.id as string,
      actionType: "status_change",
      metadata: { reason: "auto_close_stale", from_to: "→ closed" },
    });
    closed++;
  }

  return Response.json({ status: "ok", nudged, closed });
}
