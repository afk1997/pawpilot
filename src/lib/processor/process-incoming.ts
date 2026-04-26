/**
 * Background processor: runs after the webhook returns 200 to Interakt.
 *
 * V1.2 architecture — LLM-driven:
 *   - The LLM owns the conversation. Greetings, intent recognition,
 *     dispatch, donate, volunteer, clinic, suggestions — all driven by
 *     the model and its tools.
 *   - The orchestrator's only jobs are:
 *       1. Concurrency control (advisory lock per conversation, so two
 *          inbounds 1ms apart don't produce contradictory replies).
 *       2. Post-LLM card override — if a card-class tool returned data,
 *          replace the LLM's text with the deterministic card. This is
 *          the SAFETY NET against phone-digit hallucination.
 *       3. Fallback when the LLM literally throws (with retry).
 *       4. "menu" keyword shortcut (cheap, harmless).
 *   - The deterministic intent rails introduced in V1.1.1 have been
 *     removed — they made the agent feel like a chatbot and the user
 *     explicitly rejected that pattern.
 */
import { supabase } from "../supabase";
import { sendWhatsAppMessage } from "../whatsapp";
import { audit } from "../audit";
import { runAgentTurn, type ToolCallRecord } from "../ai";
import { buildAmbulanceCard, buildMultiAmbulanceCard } from "../ambulance-card";
import { buildDonationCard } from "../cards/donation";
import { buildVolunteerCard } from "../cards/volunteer";
import { buildClinicCard, type ClinicRow } from "../cards/clinic";
import { menuMessage } from "../messages/welcome";
import { withConversationLock } from "../conversation-lock";
import type { Language } from "../types";

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
}

interface ToolDerivedDelivery {
  text: string;
  delivered_ambulance_id?: string;
}

const FALLBACK_TRANSIENT: Record<Language, string> = {
  en: "One moment — let me check that for you.",
  hi: "एक पल — मैं आपके लिए देख रहा हूँ।",
  mr: "एक क्षण — मी तुमच्यासाठी तपासतो.",
  gu: "એક ક્ષણ — હું તમારા માટે તપાસું છું.",
};

const FALLBACK_EXHAUSTED: Record<Language, string> = {
  en: "Sorry, I'm having trouble right now. A team member will reach out shortly.",
  hi: "क्षमा करें, मुझे अभी कुछ समस्या आ रही है। हमारी टीम का सदस्य जल्द ही आपसे संपर्क करेगा।",
  mr: "क्षमस्व, मला आत्ता थोडी अडचण येत आहे. आमच्या टीममधील कोणीतरी लवकरच तुमच्याशी संपर्क करेल.",
  gu: "માફ કરશો, મને હાલ થોડી તકલીફ છે. અમારી ટીમનો કોઈ સભ્ય ટૂંક સમયમાં તમારો સંપર્ક કરશે.",
};

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

  // ── Everything else: LLM owns the turn ───────────────────────────────

  // Pull last 20 messages as conversation history (excluding old instant-acks).
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

  // Read replicas can lag — append the just-arrived inbound if it didn't
  // make it into the SELECT yet.
  const lastUser = [...filtered].reverse().find((m) => m.role === "user");
  if (!lastUser || lastUser.content !== input.inboundText) {
    filtered.push({ role: "user", content: input.inboundText });
  }

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

  if (result.escalated) {
    if (result.text) await sendAndPersist(input, result.text, { escalated: true });
    return;
  }

  // ── Post-LLM deterministic card override (the safety net) ────────────
  // If the LLM called a card-class tool, replace its text with the canonical
  // card. This is critical: even if the model hallucinates phone digits or
  // formats the response wrong, the orchestrator wins.
  const override = await deriveCardFromToolCalls(result.toolCalls, input.language);

  let outboundText = result.text;
  let deliveredAmbulanceId: string | undefined;

  if (override) {
    outboundText = override.text;
    deliveredAmbulanceId = override.delivered_ambulance_id;
  } else if (!outboundText || outboundText.trim().length === 0) {
    outboundText =
      result.error === "transient"
        ? FALLBACK_TRANSIENT[input.language] ?? FALLBACK_TRANSIENT.en
        : FALLBACK_EXHAUSTED[input.language] ?? FALLBACK_EXHAUSTED.en;
  }

  await sendAndPersist(input, outboundText, {
    hit_step_cap: result.hitStepCap,
    usage: result.usage ?? null,
    overridden: !!override,
    error: result.error,
  });

  await updateStatusAfterTurn(input.conversationId, deliveredAmbulanceId, override !== null);
}

/**
 * Look at the tool calls the LLM made this turn. If any of them produced a
 * deterministic delivery card, build that card and return it.
 */
async function deriveCardFromToolCalls(
  toolCalls: ToolCallRecord[],
  language: Language
): Promise<ToolDerivedDelivery | null> {
  // 1. find_ambulance_by_area: 1 → single card; 2-3 → multi-card; 4+ defer to LLM.
  for (const tc of toolCalls) {
    if (tc.name !== "find_ambulance_by_area") continue;
    if (tc.failed) continue;
    const rows = (tc.output as Array<unknown>) ?? [];
    if (!Array.isArray(rows) || rows.length === 0) continue;

    type Row = {
      id: string;
      city: string;
      area: string | null;
      phone: string;
      operator_name: string;
      operator_is_arham: boolean;
    };

    if (rows.length === 1) {
      const row = rows[0] as Row;
      const card = buildAmbulanceCard(row, language);
      return { text: card.full_message, delivered_ambulance_id: row.id };
    }

    if (rows.length <= 3) {
      const typed = rows as Row[];
      const text = buildMultiAmbulanceCard(typed, language);
      return { text };
    }
    continue;
  }

  // 2. get_nearest_ambulance returns a single row → deliver card.
  for (const tc of toolCalls) {
    if (tc.name !== "get_nearest_ambulance") continue;
    if (tc.failed) continue;
    const row = tc.output as null | {
      id: string;
      city: string;
      area: string | null;
      phone: string;
      operator_name: string;
      operator_is_arham: boolean;
    };
    if (!row) continue;
    const card = buildAmbulanceCard(row, language);
    return { text: card.full_message, delivered_ambulance_id: row.id };
  }

  // 3. get_static_content topic → deterministic card.
  for (const tc of toolCalls) {
    if (tc.name !== "get_static_content") continue;
    if (tc.failed) continue;
    const inp = tc.input as { topic?: string };
    if (inp?.topic === "donate") return { text: buildDonationCard(language) };
    if (inp?.topic === "volunteer") return { text: buildVolunteerCard(language) };
    if (inp?.topic === "clinics") {
      const rows = Array.isArray(tc.output) ? (tc.output as ClinicRow[]) : [];
      return { text: buildClinicCard(rows, language) };
    }
  }

  return null;
}

async function sendAndPersist(
  input: ProcessIncomingInput,
  text: string,
  metadata: Record<string, unknown> = {}
): Promise<void> {
  console.log(
    `[processor] sending to ${input.reporterPhone} (${text.length} chars) meta=${JSON.stringify(metadata)}`
  );
  const send = await sendWhatsAppMessage(input.reporterPhone, text);
  console.log(
    `[processor] send result ok=${send.ok} status=${send.status} error=${send.error ?? "none"}`
  );
  const inserted = await supabase
    .from("messages")
    .insert({
      conversation_id: input.conversationId,
      role: "assistant",
      content: text,
      message_type: "text",
      delivery_status: send.ok ? "sent" : "failed",
      failed_reason: send.ok
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
}

function isMenuRequest(text: string): boolean {
  if (!text) return false;
  const t = text.trim().toLowerCase();
  return /^(menu|options?|help|sahaay|मेन्यू|पर्याय|मेनू|menyu|મેનુ)$/.test(t);
}

async function hasUsableLocation(conversationId: string): Promise<boolean> {
  const { data } = await supabase
    .from("messages")
    .select("content, location_lat")
    .eq("conversation_id", conversationId)
    .eq("role", "user")
    .order("created_at", { ascending: false })
    .limit(20);
  if (!data) return false;
  for (const m of data) {
    if (m.location_lat !== null && m.location_lat !== undefined) return true;
    const txt = ((m.content as string) ?? "").toLowerCase();
    if (LOCATION_HINTS.some((h) => txt.includes(h))) return true;
  }
  return false;
}

const LOCATION_HINTS: string[] = [
  "ahmedabad", "bhavnagar", "gondal", "junagadh", "mandvi", "palitana",
  "surat", "vadodara", "veraval", "gandhinagar", "morbi", "rajkot",
  "jamnagar", "vapi",
  "mumbai", "pune", "nagpur", "solapur", "amravati",
  "delhi", "chennai", "hyderabad", "indore", "kolkata", "bengaluru",
  "bangalore", "gurugram", "gurgaon",
  "kandivali", "borivali", "dahisar", "malad", "mira road", "bhayandar",
  "andheri", "vile parle", "juhu", "santacruz", "jogeshwari", "lokhandwala",
  "ghatkopar", "vikhroli", "chembur", "mulund", "bhandup", "nahur",
  "dombivali", "tardeo", "dadar", "wadala", "goregaon",
  "pcmc", "pimpri", "chinchwad", "dehu", "bhosari", "baner", "khadki",
  "hinjewadi", "swargate", "dhankawadi", "kondwa", "yewalewadi",
  "ambegaon", "handewadi", "ghorpadi",
  "phoenix", "marketcity", "vesu", "varachha", "nasik highway",
  "old delhi", "shalimar bagh", "ashok vihar", "rana pratap",
  "मुंबई", "पुणे", "दिल्ली", "अहमदाबाद", "घाटकोपर", "कांदिवली",
  "મુંબઈ", "અમદાવાદ", "સુરત", "વડોદરા",
];

async function updateStatusAfterTurn(
  conversationId: string,
  deliveredAmbulanceId: string | undefined,
  hadOverride: boolean
): Promise<void> {
  if (deliveredAmbulanceId) {
    const followupAt = new Date(Date.now() + FOLLOWUP_DELAY_MIN * 60_000).toISOString();
    await supabase
      .from("conversations")
      .update({
        status: "number_delivered",
        delivered_ambulance_id: deliveredAmbulanceId,
        delivered_at: new Date().toISOString(),
        awaiting_followup_at: followupAt,
        updated_at: new Date().toISOString(),
      })
      .eq("id", conversationId);
    return;
  }

  const { data: convo } = await supabase
    .from("conversations")
    .select("status")
    .eq("id", conversationId)
    .single();
  if (convo?.status === "new" || convo?.status === "awaiting_intent") {
    await supabase
      .from("conversations")
      .update({
        status: hadOverride ? convo.status : "awaiting_location",
        updated_at: new Date().toISOString(),
      })
      .eq("id", conversationId);
  }
}
