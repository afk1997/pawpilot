/**
 * Background processor: runs after the webhook returns 200 to Interakt.
 *
 * Key responsibility (V1.1): the LLM contributes zero characters to
 * delivery messages. The orchestrator inspects the LLM's tool calls and,
 * if a card-class tool succeeded, replaces the LLM's text with the
 * deterministic card. The LLM's job is reduced to deciding which tool to
 * call and writing conversational glue when no tool resolved the turn.
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
import type { Language } from "../types";

const FOLLOWUP_DELAY_MIN = Number(process.env.FOLLOWUP_DELAY_MIN ?? 5);

export interface ProcessIncomingInput {
  conversationId: string;
  inboundMessageId: string;
  inboundText: string;
  reporterPhone: string;
  reporterName: string | null;
  language: Language;
}

interface ToolDerivedDelivery {
  text: string;
  /** Set when the agent should mark this conversation as having delivered a
   *  specific ambulance, so the followup cron can find it. */
  delivered_ambulance_id?: string;
}

const FALLBACK_CLARIFY: Record<Language, string> = {
  en: "Sorry, could you tell me what you need help with? Reply 'menu' to see the options again.",
  hi: "माफ़ कीजिए, कृपया बताएँ आपको किस चीज़ में मदद चाहिए? विकल्प देखने के लिए 'menu' लिखें।",
  mr: "क्षमस्व, कृपया सांगा तुम्हाला कशासाठी मदत हवी आहे? पर्याय पाहण्यासाठी 'menu' लिहा.",
  gu: "માફ કરશો, કૃપા કરીને જણાવો તમને કઈ બાબતમાં મદદ જોઈએ છે? વિકલ્પો જોવા માટે 'menu' લખો.",
};

export async function processIncoming(input: ProcessIncomingInput): Promise<void> {
  // Quick-path rails before we even invoke the LLM. These don't need the model.
  // The model can be unreliable at simple-greeting handling — Gemini and most
  // LLMs love to greet back warmly when prompted "hello", ignoring "be terse"
  // instructions. Route greetings + menu requests deterministically.
  if (isMenuRequest(input.inboundText) || isPlainGreeting(input.inboundText)) {
    const text = menuMessage(input.language);
    await sendAndPersist(input, text, {
      kind: isMenuRequest(input.inboundText) ? "menu_redisplay" : "greeting_menu",
    });
    return;
  }

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

  // Determine current conversation status.
  const { data: convo } = await supabase
    .from("conversations")
    .select("status, mode, delivered_ambulance_id")
    .eq("id", input.conversationId)
    .single();

  if (!convo) return;
  if (convo.mode === "human") return;

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

  // Escalation handler — runAgentTurn already flipped DB state via the tool.
  if (result.escalated) {
    if (result.text) {
      await sendAndPersist(input, result.text, { escalated: true });
    }
    return;
  }

  // ── Post-LLM deterministic card override ─────────────────────────────────
  // Inspect tool calls. If a card-class tool succeeded, the orchestrator
  // builds the card and uses it as the outbound text — overriding any
  // text the LLM generated.
  const override = await deriveCardFromToolCalls(result.toolCalls, input.language);

  let outboundText = result.text;
  let deliveredAmbulanceId: string | undefined;

  if (override) {
    outboundText = override.text;
    deliveredAmbulanceId = override.delivered_ambulance_id;
  } else if (!outboundText || outboundText.trim().length === 0) {
    // No card to deliver, no LLM text → degraded path. Send a clarification.
    outboundText = FALLBACK_CLARIFY[input.language] ?? FALLBACK_CLARIFY.en;
  }

  await sendAndPersist(input, outboundText, {
    hit_step_cap: result.hitStepCap,
    usage: result.usage ?? null,
    overridden: !!override,
  });

  await updateStatusAfterTurn(input.conversationId, deliveredAmbulanceId, override !== null);
}

/**
 * Look at the tool calls the LLM made this turn. If any of them produced a
 * deterministic delivery card, build that card and return it. Single-row
 * ambulance match is the most common case.
 *
 * Priority order — if multiple tools fired, ambulance dispatch wins (it's
 * the highest-stakes path).
 */
async function deriveCardFromToolCalls(
  toolCalls: ToolCallRecord[],
  language: Language
): Promise<ToolDerivedDelivery | null> {
  // 1. find_ambulance_by_area:
  //    1 row → single card delivery.
  //    2-3 rows → multi-card delivery (e.g. Rajkot has 2 partner NGOs both
  //              covering the whole city; user can't disambiguate by area).
  //    4+ rows → fall through; let the LLM ask for area (Mumbai etc.).
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
      // Don't stamp a single delivered_ambulance_id for multi-card delivery —
      // we don't know which the reporter will pick. Followup cron skips
      // these (it requires delivered_ambulance_id set).
      return { text };
    }

    // 4+ rows: fall through — orchestrator will keep the LLM's text (the
    // LLM is supposed to ask "which area in <city>?").
    continue;
  }

  // 3. get_static_content('donate') → donation card.
  for (const tc of toolCalls) {
    if (tc.name !== "get_static_content") continue;
    if (tc.failed) continue;
    const inp = tc.input as { topic?: string };
    if (inp?.topic === "donate") {
      return { text: buildDonationCard(language) };
    }
    if (inp?.topic === "volunteer") {
      return { text: buildVolunteerCard(language) };
    }
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
  if (/^(menu|options?|help|sahaay|मेन्यू|पर्याय|मेनू|menyu)$/.test(t)) return true;
  return false;
}

/**
 * Plain greetings (hi/hello/hey/namaste/etc.) — short messages with no
 * actionable content. Route these to the menu instead of asking the LLM,
 * which loves to greet back with verbose openers.
 *
 * Keep tight: must be the entire message (no embedded text), short, and
 * matches one of the known greeting tokens.
 */
function isPlainGreeting(text: string): boolean {
  if (!text) return false;
  const t = text.trim().toLowerCase().replace(/[!.?,;:]+$/g, "");
  if (t.length === 0 || t.length > 30) return false;
  // Strip trailing emojis to match "hi 👋" style.
  const stripped = t.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}‍\u{FE0F}]+$/gu, "").trim();
  return /^(hi+|hello+|hey+|hii+|hyy+|yo|hola|namaste|namaskaar|namaskar|namaskaram|adab|salaam|salam|वणक्कम|नमस्ते|नमस्कार|नमस्कारम|नमस्कारे|नमस्कारम्|नमस्ते जी|नमस्कार जी|नमस्ते जी|નમસ્તે|નમસ્કાર|good\s+(morning|afternoon|evening|day))$/.test(
    stripped
  );
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
  "dombivali", "tardeo", "dadar", "wadala",
  "pcmc", "pimpri", "chinchwad", "dehu", "bhosari", "baner", "khadki",
  "hinjewadi", "swargate", "dhankawadi", "kondwa", "yewalewadi",
  "ambegaon", "handewadi", "ghorpadi",
  "phoenix", "marketcity", "vesu", "varachha", "nasik highway",
  "old delhi", "shalimar bagh", "ashok vihar", "rana pratap",
  "मुंबई", "पुणे", "दिल्ली", "अहमदाबाद", "घाटकोपर", "कांदिवली",
  "મુંબઈ", "અમદાવાદ", "સુરત", "વડોદરા",
];

/**
 * After the orchestrator overrides with a card, transition status:
 *   - delivered an ambulance card → status=number_delivered, awaiting_followup_at=now+N
 *   - any other override or LLM text → status=awaiting_intent if from 'new'
 *     (one step further into the conversation)
 */
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

  // No ambulance delivery — just nudge status one step further if we were 'new'.
  const { data: convo } = await supabase
    .from("conversations")
    .select("status")
    .eq("id", conversationId)
    .single();
  if (convo?.status === "new" || convo?.status === "awaiting_intent") {
    // If the LLM is still chatting (no card delivered), and the inbound
    // hinted at an ambulance, we've moved into awaiting_location.
    await supabase
      .from("conversations")
      .update({
        status: hadOverride ? convo.status : "awaiting_location",
        updated_at: new Date().toISOString(),
      })
      .eq("id", conversationId);
  }
}
