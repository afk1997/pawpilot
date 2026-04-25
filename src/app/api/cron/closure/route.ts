/**
 * Vercel Cron: opportunistic closure summaries.
 *
 * Schedule: every 5 minutes.
 *
 * For each conversation that has had a number delivered but is not yet
 * closed/escalated, query Arham's Cases API by reporter phone for cases
 * created after delivered_at. If found, send a closure summary.
 *
 * Partner-NGO-handled cases are NOT in Arham's API — those will never
 * trigger a closure here. By design.
 *
 * If the closure lands >24 hours after the reporter's last inbound message,
 * WhatsApp's free-form window is closed; we use a pre-approved Interakt
 * template instead.
 */
import { NextRequest } from "next/server";
import { supabase } from "@/lib/supabase";
import { sendWhatsAppMessage, sendWhatsAppTemplate } from "@/lib/whatsapp";
import { audit } from "@/lib/audit";
import { getCaseByReporter } from "@/lib/clients/cases-api";
import { buildClosureMessage } from "@/lib/messages/closure";
import type { Language } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

function authorized(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const provided = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  return provided === secret;
}

export async function GET(request: NextRequest) {
  if (!authorized(request)) return new Response("forbidden", { status: 403 });

  // Pull conversations awaiting closure. We exclude already-closed and
  // escalated ones (escalated cases are dispatcher's manual responsibility).
  const { data: candidates, error } = await supabase
    .from("conversations")
    .select("id, phone, language, delivered_at, last_inbound_at")
    .not("delivered_at", "is", null)
    .not("status", "in", "(closed,escalated)")
    .order("delivered_at", { ascending: true })
    .limit(100);

  if (error) {
    console.error("closure cron query failed:", error);
    return Response.json({ error: error.message }, { status: 500 });
  }
  if (!candidates || candidates.length === 0) {
    return Response.json({ status: "ok", processed: 0, closed: 0 });
  }

  let processed = 0;
  let closed = 0;
  for (const c of candidates) {
    processed++;
    const phone = c.phone as string;
    const deliveredAt = new Date(c.delivered_at as string);

    // Skip very-recently-delivered cases — give the team time to log.
    if (Date.now() - deliveredAt.getTime() < 30 * 60_000) continue;

    const caseRecord = await getCaseByReporter(phone, 14);
    if (!caseRecord) continue;
    const caseCreated = new Date(caseRecord.created_at ?? caseRecord.treated_at ?? Date.now());
    if (caseCreated < deliveredAt) continue; // case is older than this conversation's dispatch — skip

    const language = ((c.language as Language | null) ?? "en") as Language;
    const parts = buildClosureMessage(language, deliveredAt, caseRecord);

    const lastInbound = c.last_inbound_at
      ? new Date(c.last_inbound_at as string)
      : deliveredAt;
    const inWindow = Date.now() - lastInbound.getTime() < TWENTY_FOUR_HOURS_MS;

    let sent;
    let isTemplate = false;
    if (inWindow) {
      sent = await sendWhatsAppMessage(phone, parts.freeForm);
    } else {
      isTemplate = true;
      sent = await sendWhatsAppTemplate(
        phone,
        parts.templateName,
        language,
        parts.templateBodyValues
      );
    }

    const inserted = await supabase
      .from("messages")
      .insert({
        conversation_id: c.id,
        role: "assistant",
        content: parts.freeForm,
        message_type: isTemplate ? "template" : "text",
        is_template: isTemplate,
        template_name: isTemplate ? parts.templateName : null,
        delivery_status: sent.ok ? "sent" : "failed",
        failed_reason: sent.ok ? null : (sent.error ?? "send failed"),
      })
      .select("id")
      .single();

    await supabase
      .from("conversations")
      .update({ status: "closed", updated_at: new Date().toISOString() })
      .eq("id", c.id);

    await audit({
      conversationId: c.id as string,
      messageId: inserted.data?.id ?? null,
      actionType: "closure_sent",
      messageText: parts.freeForm,
      metadata: {
        case_id: caseRecord.id,
        used_template: isTemplate,
        template_name: isTemplate ? parts.templateName : null,
      },
    });

    closed++;
  }

  return Response.json({ status: "ok", processed, closed });
}
