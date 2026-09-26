import { and, desc, eq, gte } from "drizzle-orm";
import { getDb } from "../db/client";
import { turns, type Conversation, type Message } from "../db/schema";
import { getConfig } from "../config";
import { log, safeErrorFields } from "../log";
import type { Language } from "../types";
import { getBackend } from "../agent";
import type { BackendErrorKind, LLMBackend, ObservedToolUse, StructuredReply, TurnResult } from "../agent/types";
import { extractTokens, HandleRegistry } from "../agent/handles";
import { createArhamTools, SERVER_NAME, type ToolCallRecord, type ToolContext } from "../agent/tools";
import { buildSystemPrompt, buildTurnPrompt, formatIst } from "../agent/prompt";
import { renderTranscript } from "../agent/transcript";
import { renderReply, type RenderResult } from "../agent/render";
import { findDigitRuns, foreignDigitRuns, hasDispatchLanguage, replaceDispatchSentences, stripRuns } from "../agent/scrub";
import { getCoverageSummary } from "../directory/coverage";
import type { DirectoryAmbulance } from "../directory/matcher";
import { getAmbulancesByIds, getClinicsByIds } from "../directory/repo";
import { foldDigits, getStaticPhones } from "../content/static";
import { formatIndianPhone, renderNumberForToken } from "../messages/cards";
import { callDirectlyLine, DISPATCH_CORRECTION_NOTE, TOKEN_CORRECTION_NOTE } from "../messages/system-replies";
import { recordEvent } from "../inbound/store";
import { loadHistory } from "./gather";
import { deliverText } from "./deliver";
import { createTurn, finishTurn, flagConversation, loadConversationHandles, markAnswered, updateConversation } from "./persist";
import { isClaudePaused, pauseClaude, recordOkTurn } from "./pause";
import { runFallbackTurn } from "./fallback";

/** How long Claude stays paused after AUTH, or after LIMITED without a reset time. */
const PAUSE_FALLBACK_MS = 15 * 60 * 1000;
/** A location Claude reported longer ago than this is no longer known. */
const LOCATION_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** The transcript's length in messages, and the shorter one an INVALID_OUTPUT retry gets. */
const TRANSCRIPT_LIMIT = 30;
const SHORT_TRANSCRIPT_LIMIT = 10;
/** The SDK's name for this app's tools: mcp__arham__find_ambulances for find_ambulances. */
const MCP_PREFIX = `mcp__${SERVER_NAME}__`;
/** The tool the CLI adds to carry the structured reply; not a call the model made. */
const STRUCTURED_OUTPUT_TOOL = "StructuredOutput";
/** Delivery statuses of a reply the reporter got; a test conversation skips the send by design. */
const DELIVERED = new Set(["sent", "test_skipped"]);
const DIGIT_RE = /\p{Nd}/u;
/** A dropped piece of template syntax always holds a brace; a dropped token's value never does. */
const SYNTAX_RE = /[{}]/;

/** The fallback reason, and the prefix of the turn's error, for each backend failure. */
const FAILURE_REASON: Record<BackendErrorKind, string> = {
  LIMITED: "claude_limited",
  AUTH: "claude_auth",
  INVALID_OUTPUT: "claude_invalid_output",
  TRANSIENT: "claude_transient",
};

/** One reply the model wrote, rendered, with what the digit guard found in it. */
interface Draft {
  structured: StructuredReply;
  rendered: RenderResult;
  /** The digit guard's allow-list: the numbers code inserted, and every run in this turn's tool outputs. */
  allowed: string[];
  /** Phone-shaped runs the model typed. */
  foreign: string[];
  /** Dropped tokens or template syntax holding a digit: a number the model tried to write inside a token. */
  digitDrops: string[];
}

const violatesDigitGuard = (d: Draft) => d.foreign.length > 0 || d.digitDrops.length > 0;

/** Records an event, best effort: a failing events insert must never cost the reporter the reply. */
async function note(conversationId: string, kind: string, payload: Record<string, unknown>): Promise<void> {
  try {
    await recordEvent(kind, payload, conversationId);
  } catch {
    log.warn({ conversationId, kind }, "event not recorded");
  }
}

/** The newest location Claude reported in the conversation's last five turns, if within LOCATION_MAX_AGE_MS of now. */
async function lastKnownLocation(conversationId: string, now: Date): Promise<{ city: string | null; area: string | null } | null> {
  const rows = await getDb()
    .select({ structuredOutput: turns.structuredOutput })
    .from(turns)
    .where(and(eq(turns.conversationId, conversationId), gte(turns.createdAt, new Date(now.getTime() - LOCATION_MAX_AGE_MS))))
    .orderBy(desc(turns.createdAt))
    .limit(5);
  for (const { structuredOutput } of rows) {
    const loc = (structuredOutput as { location?: { city?: string | null; area?: string | null } } | null)?.location;
    if (loc && (loc.city || loc.area)) return { city: loc.city ?? null, area: loc.area ?? null };
  }
  return null;
}

/**
 * The ambulance and clinic handles in the templates of replies the reporter got, oldest first, each once. Only handles
 * the registry still resolves: one the model invented was never shared.
 */
function sharedHandles(history: Message[], registry: HandleRegistry): string[] {
  const shared = new Set<string>();
  for (const m of history) {
    if (m.role !== "assistant" || !m.contentTemplate || !DELIVERED.has(m.deliveryStatus ?? "")) continue;
    for (const t of extractTokens(m.contentTemplate)) {
      if (t.kind !== "PHONE" && registry.resolve(t.value)) shared.add(t.value.toLowerCase());
    }
  }
  return [...shared];
}

/**
 * Audit records for the tool uses of one attempt that reached no tool: the SDK refused them before the call. Uses are
 * matched to the calls the tools recorded in that attempt by name and order; the CLI's StructuredOutput is skipped.
 */
function refusedToolUses(uses: ObservedToolUse[], recorded: ToolCallRecord[]): ToolCallRecord[] {
  const unmatched = new Map<string, number>();
  for (const c of recorded) unmatched.set(c.name, (unmatched.get(c.name) ?? 0) + 1);
  const refused: ToolCallRecord[] = [];
  for (const use of uses) {
    if (use.name === STRUCTURED_OUTPUT_TOOL) continue;
    const name = use.name.startsWith(MCP_PREFIX) ? use.name.slice(MCP_PREFIX.length) : use.name;
    const left = unmatched.get(name) ?? 0;
    if (left > 0) unmatched.set(name, left - 1);
    else refused.push({ name: use.name, input: null, output: null, durationMs: 0, error: { errorClass: "SdkRejected" } });
  }
  return refused;
}

/**
 * replaceDispatchSentences on the stored template. The template's numbers are tokens, which that function does not
 * see, so a token inside a replaced sentence goes back right after the replacement line, as its number does in the text.
 */
function replaceDispatchInTemplate(template: string, line: string, allowed: string[]): string {
  const out = replaceDispatchSentences(template, line, allowed);
  const lost = [...new Set(extractTokens(template).map((t) => t.raw))].filter((raw) => !out.includes(raw));
  if (lost.length === 0) return out;
  const at = out.indexOf(line);
  if (at < 0) return `${out} ${lost.join(" ")}`;
  const end = at + line.length;
  return `${out.slice(0, end)} ${lost.join(" ")}${out.slice(end)}`;
}

/**
 * The Claude branch of a turn (spec §5.3 steps 5–9, §5.4, §5.9): the backend call with one retry for INVALID_OUTPUT or
 * TRANSIENT, rendering, the digit guard and the dispatch guard (each one corrective retry, then strip or replace), the
 * send and the audit. Never throws for a backend failure: a pause, any failure and an empty reply end in the no-LLM
 * fallback. `outcome` is "failed" when the reply was not delivered.
 */
export async function runClaudeTurn(input: {
  conversation: Conversation;
  pending: Message[];
  lang: Language;
  welcomeJustSent: boolean;
  /** getBackend() when absent. */
  backend?: LLMBackend;
  now: () => Date;
}): Promise<{ turnId: string; outcome: "ok" | "fallback" | "failed" }> {
  const { conversation, pending, now } = input;
  const conversationId = conversation.id;
  const cfg = getConfig();

  if (await isClaudePaused(now())) {
    const r = await runFallbackTurn({ conversation, pending, reason: "claude_paused" });
    return { turnId: r.turn.id, outcome: "fallback" };
  }

  // Read before this turn's row exists, so the five turns searched are all earlier ones.
  const knownLocation = await lastKnownLocation(conversationId, now());
  const turn = await createTurn({ conversationId, status: "failed", model: cfg.claude.model, effort: cfg.claude.effort });
  const history = await loadHistory(conversationId, TRANSCRIPT_LIMIT);
  const registry = new HandleRegistry(conversationId, await loadConversationHandles(conversationId));
  const toolContext: ToolContext = {
    conversationId, language: input.lang, registry, calls: [], lastAmbulanceCandidates: null, lastAmbulanceMatch: null,
  };
  const { server, allowedToolNames } = createArhamTools(toolContext);
  const systemPrompt = buildSystemPrompt({ coverage: await getCoverageSummary(), websiteUrl: cfg.websiteUrl });
  const handlesShared = sharedHandles(history, registry);

  /** Tool uses the SDK refused, over every attempt; audited after the calls the tools recorded. */
  const refused: ToolCallRecord[] = [];
  const auditCalls = () => [...toolContext.calls, ...refused];
  let extraUsage = false;

  const fail = async (reason: string, message: string, extra: { sessionId?: string | null; latencyMs?: number; structuredOutput?: unknown } = {}) => {
    // The reason only: the message can quote SDK error text, so it goes on the turn row and in events.
    log.warn({ conversationId, reason }, "claude turn fell back");
    await finishTurn(turn.id, { status: "failed", error: `${reason}: ${message}`, toolCalls: auditCalls(), handles: registry.toJSON(), ...extra });
    const r = await runFallbackTurn({ conversation, pending, reason });
    return { turnId: r.turn.id, outcome: "fallback" as const };
  };

  let backend: LLMBackend;
  try {
    backend = input.backend ?? getBackend();
  } catch (e) {
    const fields = safeErrorFields(e);
    await note(conversationId, "claude_backend_error", { turnId: turn.id, ...fields });
    return fail("backend_unavailable", fields.errorClass);
  }

  const promptFor = (opts: { transcriptLimit: number; correction: string | null }) =>
    buildTurnPrompt({
      nowIst: formatIst(now()),
      language: conversation.language,
      knownLocation,
      handlesShared,
      welcomeJustSent: input.welcomeJustSent,
      transcript: renderTranscript(history.slice(-opts.transcriptLimit), pending, now()),
      correction: opts.correction,
    });

  /** One backend call. A throw counts as TRANSIENT; LIMITED and AUTH pause Claude on whichever attempt they end. */
  const call = async (prompt: string): Promise<TurnResult> => {
    const before = toolContext.calls.length;
    const started = Date.now();
    let r: TurnResult;
    try {
      r = await backend.runTurn({ conversationId, systemPrompt, prompt, toolServer: server, allowedToolNames, timeoutMs: cfg.claude.turnTimeoutMs, toolContext });
    } catch (e) {
      const fields = safeErrorFields(e);
      await note(conversationId, "claude_backend_error", { turnId: turn.id, ...fields });
      r = { ok: false, kind: "TRANSIENT", message: `backend threw ${fields.errorClass}`, retryAfter: null, latencyMs: Date.now() - started, sessionId: null };
    }
    refused.push(...refusedToolUses(r.toolUses ?? [], toolContext.calls.slice(before)));
    if (r.ok) {
      if (r.extraUsage) extraUsage = true;
    } else if (r.kind === "LIMITED") {
      await pauseClaude(r.retryAfter ?? new Date(now().getTime() + PAUSE_FALLBACK_MS), "LIMITED");
      await note(conversationId, "claude_limited", { turnId: turn.id, message: r.message, retryAfter: r.retryAfter });
    } else if (r.kind === "AUTH") {
      await pauseClaude(new Date(now().getTime() + PAUSE_FALLBACK_MS), "AUTH");
      await note(conversationId, "claude_auth_error", { turnId: turn.id, message: r.message });
    }
    return r;
  };

  // Attempt 1, with one retry for INVALID_OUTPUT (shorter transcript) or TRANSIENT.
  let res = await call(promptFor({ transcriptLimit: TRANSCRIPT_LIMIT, correction: null }));
  if (!res.ok && (res.kind === "INVALID_OUTPUT" || res.kind === "TRANSIENT")) {
    res = await call(promptFor({ transcriptLimit: res.kind === "INVALID_OUTPUT" ? SHORT_TRANSCRIPT_LIMIT : TRANSCRIPT_LIMIT, correction: null }));
  }
  if (!res.ok) return fail(FAILURE_REASON[res.kind], res.message, { sessionId: res.sessionId, latencyMs: res.latencyMs });
  const first = res;

  /** Directory rows of the ambulances this turn rendered, by phone, so a number sent again keeps its partner label. */
  const ambulanceByPhone = new Map<string, DirectoryAmbulance>();
  const lookups = {
    ambulance: async (id: string) => {
      const row = (await getAmbulancesByIds([id])).get(id);
      if (row) ambulanceByPhone.set(row.phone, row);
      return row;
    },
    clinic: async (id: string) => (await getClinicsByIds([id])).get(id),
  };

  const draft = async (structured: StructuredReply): Promise<Draft> => {
    const rendered = await renderReply({
      // Native numerals as ASCII first, so a number in any script meets the guards as one.
      replyTemplate: foldDigits(structured.reply),
      lang: structured.language,
      intent: structured.intent,
      registry,
      lookups,
      helplinePhone: cfg.helplinePhone,
      staticPhones: getStaticPhones(),
      // A reply that hands the reporter to a person gets no guessed unit card.
      lastAmbulanceCandidates: structured.needs_human ? null : toolContext.lastAmbulanceCandidates,
      lastAmbulanceMatch: toolContext.lastAmbulanceMatch,
    });
    // Never the numbers of earlier replies: the transcript masks them, so the model retyping one is a leak.
    const allowed = [...rendered.inserted, ...toolContext.calls.flatMap((c) => findDigitRuns(JSON.stringify(c.output ?? "")))];
    return {
      structured,
      rendered,
      allowed,
      foreign: foreignDigitRuns(rendered.text, allowed),
      digitDrops: rendered.unknownHandles.filter((dropped) => DIGIT_RE.test(dropped)),
    };
  };

  /**
   * The draft's text and template with what the digit guard removes gone from both, so the next transcript never
   * shows the model digits the reporter did not get: tokens that held digits, then every run in the template itself.
   */
  const guarded = (d: Draft): { text: string; template: string } => {
    if (!violatesDigitGuard(d)) return { text: d.rendered.text, template: d.rendered.template };
    let template = d.rendered.template;
    for (const t of extractTokens(template)) if (d.digitDrops.includes(t.value)) template = template.split(t.raw).join("");
    return {
      text: d.foreign.length > 0 ? stripRuns(d.rendered.text, d.foreign, d.allowed) : d.rendered.text,
      template: stripRuns(template, foreignDigitRuns(template, d.allowed), d.allowed),
    };
  };

  let d = await draft(first.structured);

  // Digit guard: one corrective retry, then whatever is still typed is stripped.
  if (violatesDigitGuard(d)) {
    const retry = await call(promptFor({ transcriptLimit: TRANSCRIPT_LIMIT, correction: TOKEN_CORRECTION_NOTE }));
    if (retry.ok) d = await draft(retry.structured);
  }
  let { text, template } = guarded(d);

  // Dispatch guard: one corrective retry, whose reply meets the digit guard too, then sentence replacement.
  let replaced = false;
  if (hasDispatchLanguage(text)) {
    const retry = await call(promptFor({ transcriptLimit: TRANSCRIPT_LIMIT, correction: DISPATCH_CORRECTION_NOTE }));
    if (retry.ok) {
      d = await draft(retry.structured);
      ({ text, template } = guarded(d));
    }
    if (hasDispatchLanguage(text)) {
      const line = callDirectlyLine(d.structured.language);
      text = replaceDispatchSentences(text, line, d.allowed);
      template = replaceDispatchInTemplate(template, line, d.allowed);
      replaced = true;
    }
  }
  const { structured, rendered } = d;

  // Every number code inserted reaches the reporter: one a guard removed goes out again after the call-directly line.
  let restored = 0;
  if (d.foreign.length > 0 || replaced) {
    const missing = [...new Set(rendered.inserted)].filter((phone) => !text.includes(formatIndianPhone(phone)));
    if (missing.length > 0) {
      const numbers = missing.map((phone) => {
        const row = ambulanceByPhone.get(phone) ?? toolContext.lastAmbulanceCandidates?.find((c) => c.phone === phone);
        return row ? renderNumberForToken(row, structured.language) : formatIndianPhone(phone);
      });
      const line = [callDirectlyLine(structured.language), ...numbers].join(" ");
      text = text.trim() === "" ? line : `${text}\n\n${line}`;
      restored = missing.length;
    }
  }

  if (text.trim() === "") {
    await note(conversationId, "empty_reply", { turnId: turn.id });
    return fail("empty_reply", "the reply was empty after rendering", {
      sessionId: first.sessionId, latencyMs: first.latencyMs, structuredOutput: structured,
    });
  }

  // Counts only in logs: the reply and its digits stay out of them.
  const scrubbed = violatesDigitGuard(d);
  if (scrubbed) {
    await note(conversationId, "scrub_strip", { turnId: turn.id, runs: d.foreign.length, drops: d.digitDrops.length });
    log.warn({ conversationId, runs: d.foreign.length, drops: d.digitDrops.length }, "stripped model-typed digits");
  }
  if (replaced) {
    await note(conversationId, "dispatch_language_strip", { turnId: turn.id });
    log.warn({ conversationId }, "replaced dispatch language");
  }
  if (restored > 0) {
    await note(conversationId, "number_restored", { turnId: turn.id, count: restored });
    log.warn({ conversationId, count: restored }, "sent again numbers a guard removed");
  }
  const handleDrops = rendered.unknownHandles.filter((dropped) => !SYNTAX_RE.test(dropped));
  const syntaxDrops = rendered.unknownHandles.filter((dropped) => SYNTAX_RE.test(dropped));
  if (handleDrops.length > 0) await note(conversationId, "unknown_handle", { turnId: turn.id, handles: handleDrops });

  const message = await deliverText(conversation, { text, template, origin: "agent", turnId: turn.id });
  await markAnswered(pending.map((m) => m.id), turn.id);
  // A reply that was not delivered stays visible: the turn is failed, and deliverText flagged the conversation.
  const delivered = message.deliveryStatus !== "failed";
  await finishTurn(turn.id, {
    status: delivered ? "ok" : "failed",
    error: delivered ? null : "delivery_failed",
    structuredOutput: syntaxDrops.length > 0 ? { ...structured, droppedSyntax: syntaxDrops } : structured,
    toolCalls: auditCalls(),
    handles: registry.toJSON(),
    usage: extraUsage ? { ...(first.usage ?? {}), extraUsage: true } : first.usage,
    latencyMs: first.latencyMs,
    sessionId: first.sessionId,
    model: first.model ?? cfg.claude.model,
    scrubbed,
  });
  // Claude's own report of the language. The flag goes through flagConversation, so a reason already set is kept.
  await updateConversation(conversationId, { language: structured.language });
  if (structured.needs_human) await flagConversation(conversationId, "needs_human");
  if (delivered) await recordOkTurn();
  return { turnId: turn.id, outcome: delivered ? "ok" : "failed" };
}
