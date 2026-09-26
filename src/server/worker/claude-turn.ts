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
import { renderReply, type RenderLookups, type RenderResult } from "../agent/render";
import { findDigitRuns, foreignDigitRuns, hasDispatchLanguage, replaceDispatchSentences, stripRuns } from "../agent/scrub";
import { getCoverageSummary } from "../directory/coverage";
import type { DirectoryAmbulance, MatchType } from "../directory/matcher";
import { getAmbulancesByIds, getClinicsByIds, type DirectoryClinic } from "../directory/repo";
import { foldDigits, getStaticPhones } from "../content/static";
import { formatIndianPhone, renderNumberForToken } from "../messages/cards";
import { callDirectlyLine, DISPATCH_CORRECTION_NOTE, TOKEN_CORRECTION_NOTE } from "../messages/system-replies";
import { recordEvent } from "../inbound/store";
import { loadHistory } from "./gather";
import { deliverText } from "./deliver";
import { createTurn, finishTurn, flagConversation, loadConversationHandles, markAnswered, updateConversation } from "./persist";
import { isClaudePaused, pauseClaude, recordOkTurn } from "./pause";
import { runFallbackTurn } from "./fallback";

// ─── The reply guards: drafts, the digit guard, the dispatch guard, and numbers sent again ───────────────────────────

const DIGIT_RE = /\p{Nd}/u;
/** A dropped piece of template syntax always holds a brace; a dropped token's value never does. */
const SYNTAX_RE = /[{}]/;
/** A handle as makeHandle writes it (letters only): the only dropped value an event may carry. */
const HANDLE_RE = /^(?:amb|cli)_[a-p]{8}$/i;
/** Added to the token correction when a draft used the handle of a unit that is no longer active. */
export const STALE_HANDLE_NOTE = "Look the place up again with find_ambulances; a previously shared unit is no longer available.";

/** Why a backend call is made; a corrective one is "token" or "dispatch". */
export type CallPurpose = "first" | "retry" | "token" | "dispatch";

export interface GuardDeps {
  registry: HandleRegistry;
  lookups: RenderLookups;
  helplinePhone: string;
  staticPhones: Record<string, string>;
  /** The last find_ambulances result as it stands when a draft is rendered: a corrective call can change it. */
  toolState: () => { candidates: DirectoryAmbulance[] | null; match: MatchType | null };
  /** Every phone-shaped run in this turn's tool outputs so far: numbers the model may repeat. */
  toolRuns: () => string[];
  /** One corrective call: the corrected reply, or null when none came (no time left, or the call failed). */
  retry: (correction: string, purpose: "token" | "dispatch") => Promise<StructuredReply | null>;
}

export interface GuardedReply {
  /** The reply to send; empty when nothing survived the guards and no number was left to send again. */
  text: string;
  /** Its template: a token for each number it shows (the card excepted), nothing the reporter did not get. */
  template: string;
  /** The last draft's structured reply, with needs_human set when any draft of the turn set it. */
  structured: StructuredReply;
  /** The sent draft had digits the model typed removed: phone-shaped runs, or dropped pieces holding a digit. */
  scrubbed: boolean;
  foreignRuns: number;
  digitDrops: number;
  /** A sentence with dispatch language was replaced. */
  replaced: boolean;
  /** Numbers a draft of this turn inserted that the reply lacked, sent again after the call-directly line. */
  restored: number;
  /** Handles the registry does not know, in the sent draft; handle-shaped, so free of digits. */
  unknownHandles: string[];
  /** Handles of units or clinics no longer active, still in the sent draft. */
  staleHandles: string[];
  /** Template syntax the sent draft dropped. */
  droppedSyntax: string[];
}

/** One reply the model wrote, rendered, with what the guards found in it. */
interface Draft {
  structured: StructuredReply;
  rendered: RenderResult;
  /** The digit guard's allow-list: the numbers code inserted, and every run in this turn's tool outputs. */
  allowed: string[];
  /** Phone-shaped runs the model typed. */
  foreign: string[];
  /** Dropped tokens or template syntax holding a digit: a number the model tried to write inside a token. */
  digitDrops: string[];
  /** Handles whose unit or clinic is no longer active. */
  stale: string[];
}

const typedDigits = (d: Draft) => d.foreign.length > 0 || d.digitDrops.length > 0;

/**
 * replaceDispatchSentences on a template. Its numbers are tokens, which that function does not see, so a token inside
 * a replaced sentence goes back right after the replacement line, as its number does in the text.
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

const appendLine = (text: string, line: string) => (text.trim() === "" ? line : `${text}\n\n${line}`);

/**
 * The guard pipeline for one reply (spec §5.9). Each draft is rendered from its native-numeral-folded reply. The digit
 * guard (typed runs, or dropped pieces holding a digit) and a stale handle get one corrective call, then typed runs are
 * stripped; the dispatch guard gets one, whose draft meets the digit guard again, then its sentences are replaced.
 * Every number any draft inserted must reach the reporter (the numbers are code-inserted, so safe): one the final
 * reply lacks goes out again after the call-directly line. needs_human holds if any draft set it, and then no draft
 * after it gets a guessed card.
 */
export async function guardReply(first: StructuredReply, deps: GuardDeps): Promise<GuardedReply> {
  const { registry } = deps;
  // Rows met while rendering, by phone, so a number sent again keeps its partner label and its token.
  const rows = new Map<string, { kind: "ambulance"; row: DirectoryAmbulance } | { kind: "clinic"; row: DirectoryClinic }>();
  // Ids a handle points at whose unit or clinic is no longer active.
  const gone = new Set<string>();
  const lookups: RenderLookups = {
    ambulance: async (id) => {
      const row = await deps.lookups.ambulance(id);
      if (row) rows.set(row.phone, { kind: "ambulance", row });
      else gone.add(id);
      return row;
    },
    clinic: async (id) => {
      const row = await deps.lookups.clinic(id);
      if (row) rows.set(row.phone, { kind: "clinic", row });
      else gone.add(id);
      return row;
    },
  };
  const inserted = new Set<string>();
  let needsHuman = false;

  const draft = async (structured: StructuredReply): Promise<Draft> => {
    needsHuman ||= structured.needs_human;
    const { candidates, match } = deps.toolState();
    const rendered = await renderReply({
      // Native numerals as ASCII first, so a number in any script meets the guards as one.
      replyTemplate: foldDigits(structured.reply),
      lang: structured.language,
      intent: structured.intent,
      registry,
      lookups,
      helplinePhone: deps.helplinePhone,
      staticPhones: deps.staticPhones,
      // A turn that hands the reporter to a person gets no guessed unit card.
      lastAmbulanceCandidates: needsHuman ? null : candidates,
      lastAmbulanceMatch: match,
    });
    if (rendered.appendedCard) for (const c of candidates ?? []) rows.set(c.phone, { kind: "ambulance", row: c });
    for (const phone of rendered.inserted) inserted.add(phone);
    // Never the numbers of earlier replies: the transcript masks them, so the model retyping one is a leak.
    const allowed = [...rendered.inserted, ...deps.toolRuns()];
    return {
      structured,
      rendered,
      allowed,
      foreign: foreignDigitRuns(rendered.text, allowed),
      digitDrops: rendered.unknownHandles.filter((dropped) => DIGIT_RE.test(dropped)),
      stale: rendered.unknownHandles.filter((dropped) => {
        const ref = registry.resolve(dropped);
        return ref !== undefined && gone.has(ref.id);
      }),
    };
  };

  /** The draft's text and sent template with the runs the model typed stripped from both. */
  const guarded = (d: Draft): { text: string; template: string } => {
    const template = d.rendered.sentTemplate;
    if (!typedDigits(d)) return { text: d.rendered.text, template };
    return {
      text: d.foreign.length > 0 ? stripRuns(d.rendered.text, d.foreign, d.allowed) : d.rendered.text,
      template: stripRuns(template, foreignDigitRuns(template, d.allowed), d.allowed),
    };
  };

  let d = await draft(first);

  // Digit guard, and a stale handle: one corrective call, then whatever is still typed is stripped.
  if (typedDigits(d) || d.stale.length > 0) {
    const correction = d.stale.length > 0 ? `${TOKEN_CORRECTION_NOTE} ${STALE_HANDLE_NOTE}` : TOKEN_CORRECTION_NOTE;
    const corrected = await deps.retry(correction, "token");
    if (corrected) d = await draft(corrected);
  }
  let { text, template } = guarded(d);

  // Dispatch guard: one corrective call, whose draft meets the digit guard again, then sentence replacement.
  let replaced = false;
  if (hasDispatchLanguage(text)) {
    const corrected = await deps.retry(DISPATCH_CORRECTION_NOTE, "dispatch");
    if (corrected) {
      d = await draft(corrected);
      ({ text, template } = guarded(d));
    }
    if (hasDispatchLanguage(text)) {
      const line = callDirectlyLine(d.structured.language);
      text = replaceDispatchSentences(text, line, d.allowed);
      template = replaceDispatchInTemplate(template, line, d.allowed);
      replaced = true;
    }
  }

  // Every number a draft inserted reaches the reporter: one the reply lacks goes out again, its token in the template.
  const lang = d.structured.language;
  const lost = [...inserted].filter((phone) => !text.includes(formatIndianPhone(phone)));
  if (lost.length > 0) {
    const numberFor = (phone: string) => {
      const seen = rows.get(phone);
      return seen?.kind === "ambulance" ? renderNumberForToken(seen.row, lang) : formatIndianPhone(phone);
    };
    const tokenFor = (phone: string) => {
      const seen = rows.get(phone);
      if (seen?.kind === "ambulance") return `{{AMB:${registry.ambulance(seen.row.id)}}}`;
      if (seen?.kind === "clinic") return `{{CLINIC:${registry.clinic(seen.row.id)}}}`;
      if (phone === deps.helplinePhone) return "{{PHONE:helpline}}";
      const key = Object.keys(deps.staticPhones).find((k) => deps.staticPhones[k] === phone);
      return key === undefined ? "[number sent]" : `{{PHONE:${key}}}`;
    };
    const line = callDirectlyLine(lang);
    text = appendLine(text, [line, ...lost.map(numberFor)].join(" "));
    template = appendLine(template, [line, ...lost.map(tokenFor)].join(" "));
  }

  const dropped = d.rendered.unknownHandles;
  return {
    text,
    template,
    structured: { ...d.structured, needs_human: needsHuman },
    scrubbed: typedDigits(d),
    foreignRuns: d.foreign.length,
    digitDrops: d.digitDrops.length,
    replaced,
    restored: lost.length,
    unknownHandles: dropped.filter((v) => HANDLE_RE.test(v) && !d.stale.includes(v)),
    staleHandles: d.stale.filter((v) => HANDLE_RE.test(v)),
    droppedSyntax: dropped.filter((v) => SYNTAX_RE.test(v)),
  };
}

// ─── Turn context from earlier turns and replies ─────────────────────────────────────────────────────────────────────

/** A location Claude reported longer ago than this is no longer known. */
const LOCATION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

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
 * The ambulance and clinic handles in the templates of replies whose send did not fail, oldest first, each once. Only
 * handles the registry still resolves: one the model invented was never shared.
 */
function sharedHandles(history: Message[], registry: HandleRegistry): string[] {
  const shared = new Set<string>();
  for (const m of history) {
    if (m.role !== "assistant" || !m.contentTemplate || m.deliveryStatus === "failed") continue;
    for (const t of extractTokens(m.contentTemplate)) {
      if (t.kind !== "PHONE" && registry.resolve(t.value)) shared.add(t.value.toLowerCase());
    }
  }
  return [...shared];
}

// ─── The turn ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The wall-clock budget for a turn's backend calls, less a reserve for rendering, the send or the fallback. */
const TURN_BUDGET_MS = 100_000;
const TURN_RESERVE_MS = 10_000;
/** A call with less time than this left is skipped: it would likely time out, and the fallback is quicker. */
const MIN_CALL_MS = 15_000;
/** How long Claude stays paused after AUTH, or after LIMITED without a reset time. */
const PAUSE_FALLBACK_MS = 15 * 60 * 1000;
/** The transcript's length in messages, and the shorter one an INVALID_OUTPUT retry gets. */
const TRANSCRIPT_LIMIT = 30;
const SHORT_TRANSCRIPT_LIMIT = 10;
/** A TRANSIENT failure that took its whole timeout; retrying it would spend the budget again. */
const TIMED_OUT_RE = /timed out/i;
/** The SDK's name for this app's tools: mcp__arham__find_ambulances for find_ambulances. */
const MCP_PREFIX = `mcp__${SERVER_NAME}__`;
/** The tool the CLI adds to carry the structured reply; not a call the model made. */
const STRUCTURED_OUTPUT_TOOL = "StructuredOutput";

/** The fallback reason, and the prefix of the turn's error, for each backend failure. */
const FAILURE_REASON: Record<BackendErrorKind, string> = {
  LIMITED: "claude_limited",
  AUTH: "claude_auth",
  INVALID_OUTPUT: "claude_invalid_output",
  TRANSIENT: "claude_transient",
};

/** Records an event, best effort: a failing events insert must never cost the reporter the reply. */
async function note(conversationId: string, kind: string, payload: Record<string, unknown>): Promise<void> {
  try {
    await recordEvent(kind, payload, conversationId);
  } catch {
    log.warn({ conversationId, kind }, "event not recorded");
  }
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

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Two usage records summed key by key: numbers add up, nested records the same way, anything else keeps its first value. */
function sumUsage(a: Record<string, unknown> | null, b: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!b) return a;
  if (!a) return { ...b };
  const out: Record<string, unknown> = { ...a };
  for (const [key, value] of Object.entries(b)) {
    const prev = out[key];
    if (typeof prev === "number" && typeof value === "number") out[key] = prev + value;
    else if (isRecord(prev) && isRecord(value)) out[key] = sumUsage(prev, value);
    else if (prev === undefined || prev === null) out[key] = value;
  }
  return out;
}

type Plan =
  | { kind: "fallback"; reason: string; message: string; sessionId?: string | null; structuredOutput?: unknown }
  | { kind: "reply"; guarded: GuardedReply; first: Extract<TurnResult, { ok: true }> };

/**
 * The Claude branch of a turn (spec §5.3 steps 5–9, §5.4, §5.9): backend calls within one time budget (a retry for
 * INVALID_OUTPUT or a TRANSIENT that was not a timeout; one correction per guard), the guards, the send and the audit.
 * Never throws for a backend failure, and not for an unexpected error before the send either: a pause, any failure,
 * an empty reply and an internal error end in the no-LLM fallback. `outcome` is "failed" when the reply was not
 * delivered.
 */
export async function runClaudeTurn(input: {
  conversation: Conversation;
  pending: Message[];
  lang: Language;
  welcomeJustSent: boolean;
  /** getBackend() when absent. */
  backend?: LLMBackend;
  now: () => Date;
  /** A monotonic clock in milliseconds, for the turn's budget and latency. */
  nowMs: () => number;
}): Promise<{ turnId: string; outcome: "ok" | "fallback" | "failed" }> {
  const { conversation, pending, now, nowMs } = input;
  const conversationId = conversation.id;
  const startedMs = nowMs();
  const deadlineMs = startedMs + TURN_BUDGET_MS - TURN_RESERVE_MS;
  const cfg = getConfig();

  if (await isClaudePaused(now())) {
    const r = await runFallbackTurn({ conversation, pending, reason: "claude_paused" });
    return { turnId: r.turn.id, outcome: "fallback" };
  }

  // Read before this turn's row exists, so the five turns searched are all earlier ones.
  const knownLocation = await lastKnownLocation(conversationId, now());
  const turn = await createTurn({ conversationId, status: "failed", model: cfg.claude.model, effort: cfg.claude.effort });

  // The audit, filled as the turn goes and kept on the turn row whichever way it ends.
  let registry: HandleRegistry | null = null;
  let toolContext: ToolContext | null = null;
  const refused: ToolCallRecord[] = [];
  let usage: Record<string, unknown> | null = null;
  let backendCalls = 0;
  let extraUsage = false;
  const audit = () => ({
    toolCalls: [...(toolContext?.calls ?? []), ...refused],
    handles: registry?.toJSON() ?? null,
    usage: backendCalls === 0 ? null : { ...usage, backendCalls, ...(extraUsage && { extraUsage: true }) },
    latencyMs: Math.round(nowMs() - startedMs),
  });

  /** Everything up to the send. Sends nothing, so a throw here can still end in the fallback. */
  const prepare = async (): Promise<Plan> => {
    const history = await loadHistory(conversationId, TRANSCRIPT_LIMIT);
    const reg = new HandleRegistry(conversationId, await loadConversationHandles(conversationId));
    registry = reg;
    const ctx: ToolContext = { conversationId, language: input.lang, registry: reg, calls: [], lastAmbulanceCandidates: null, lastAmbulanceMatch: null };
    toolContext = ctx;
    const { server, allowedToolNames } = createArhamTools(ctx);
    const systemPrompt = buildSystemPrompt({ coverage: await getCoverageSummary(), websiteUrl: cfg.websiteUrl });
    const handlesShared = sharedHandles(history, reg);

    let backend: LLMBackend;
    try {
      backend = input.backend ?? getBackend();
    } catch (e) {
      const fields = safeErrorFields(e);
      await note(conversationId, "claude_backend_error", { turnId: turn.id, ...fields });
      return { kind: "fallback", reason: "backend_unavailable", message: fields.errorClass };
    }

    const promptFor = (transcriptLimit: number, correction: string | null) =>
      buildTurnPrompt({
        nowIst: formatIst(now()),
        language: conversation.language,
        knownLocation,
        handlesShared,
        welcomeJustSent: input.welcomeJustSent,
        transcript: renderTranscript(history.slice(-transcriptLimit), pending, now()),
        correction,
      });

    /**
     * One backend call, with what is left of the budget as its timeout (at most the configured one); null, recorded as
     * retry_skipped, when too little is left. A throw counts as TRANSIENT; LIMITED and AUTH pause Claude on whichever
     * call they end.
     */
    const call = async (prompt: string, purpose: CallPurpose): Promise<TurnResult | null> => {
      const remainingMs = Math.round(deadlineMs - nowMs());
      // Never above the configured timeout, so a timeout configured below MIN_CALL_MS does not skip every call.
      if (remainingMs < Math.min(MIN_CALL_MS, cfg.claude.turnTimeoutMs)) {
        await note(conversationId, "retry_skipped", { turnId: turn.id, purpose, reason: "budget", remainingMs });
        return null;
      }
      const before = ctx.calls.length;
      const callStartedMs = nowMs();
      let r: TurnResult;
      try {
        r = await backend.runTurn({
          conversationId, systemPrompt, prompt, toolServer: server, allowedToolNames,
          timeoutMs: Math.min(cfg.claude.turnTimeoutMs, remainingMs), toolContext: ctx,
        });
      } catch (e) {
        const fields = safeErrorFields(e);
        await note(conversationId, "claude_backend_error", { turnId: turn.id, ...fields });
        r = { ok: false, kind: "TRANSIENT", message: `backend threw ${fields.errorClass}`, retryAfter: null, latencyMs: Math.round(nowMs() - callStartedMs), sessionId: null };
      }
      backendCalls += 1;
      refused.push(...refusedToolUses(r.toolUses ?? [], ctx.calls.slice(before)));
      if (r.ok) {
        usage = sumUsage(usage, r.usage);
        if (r.extraUsage) extraUsage = true;
      } else if (r.kind === "LIMITED") {
        await pauseClaude(r.retryAfter ?? new Date(now().getTime() + PAUSE_FALLBACK_MS), "LIMITED", now());
        await note(conversationId, "claude_limited", { turnId: turn.id, message: r.message, retryAfter: r.retryAfter });
      } else if (r.kind === "AUTH") {
        await pauseClaude(new Date(now().getTime() + PAUSE_FALLBACK_MS), "AUTH", now());
        await note(conversationId, "claude_auth_error", { turnId: turn.id, message: r.message });
      }
      return r;
    };

    // The first call, and one retry for INVALID_OUTPUT (shorter transcript) or a TRANSIENT failure that was no timeout.
    let res = await call(promptFor(TRANSCRIPT_LIMIT, null), "first");
    if (!res) return { kind: "fallback", reason: "claude_budget", message: "no time left for a backend call" };
    if (!res.ok && res.kind === "TRANSIENT" && TIMED_OUT_RE.test(res.message)) {
      const remainingMs = Math.round(deadlineMs - nowMs());
      await note(conversationId, "retry_skipped", { turnId: turn.id, purpose: "retry", reason: "timed_out", remainingMs });
    } else if (!res.ok && (res.kind === "INVALID_OUTPUT" || res.kind === "TRANSIENT")) {
      res = (await call(promptFor(res.kind === "INVALID_OUTPUT" ? SHORT_TRANSCRIPT_LIMIT : TRANSCRIPT_LIMIT, null), "retry")) ?? res;
    }
    if (!res.ok) return { kind: "fallback", reason: FAILURE_REASON[res.kind], message: res.message, sessionId: res.sessionId };
    const first = res;

    const guarded = await guardReply(first.structured, {
      registry: reg,
      lookups: {
        ambulance: async (id) => (await getAmbulancesByIds([id])).get(id),
        clinic: async (id) => (await getClinicsByIds([id])).get(id),
      },
      helplinePhone: cfg.helplinePhone,
      staticPhones: getStaticPhones(),
      toolState: () => ({ candidates: ctx.lastAmbulanceCandidates, match: ctx.lastAmbulanceMatch }),
      toolRuns: () => ctx.calls.flatMap((c) => findDigitRuns(JSON.stringify(c.output ?? ""))),
      retry: async (correction, purpose) => {
        const r = await call(promptFor(TRANSCRIPT_LIMIT, correction), purpose);
        return r?.ok ? r.structured : null;
      },
    });
    if (guarded.text.trim() === "") {
      await note(conversationId, "empty_reply", { turnId: turn.id });
      return {
        kind: "fallback", reason: "empty_reply", message: "the reply was empty after rendering",
        sessionId: first.sessionId, structuredOutput: guarded.structured,
      };
    }
    return { kind: "reply", guarded, first };
  };

  let plan: Plan;
  try {
    plan = await prepare();
  } catch (e) {
    // A bug or an infrastructure error before anything was sent: the reporter still gets the fallback's number.
    const fields = safeErrorFields(e);
    log.error({ conversationId, ...fields }, "claude turn failed unexpectedly");
    plan = { kind: "fallback", reason: "internal_error", message: fields.errorClass };
  }

  if (plan.kind === "fallback") {
    // The reason only: the message can quote SDK error text, so it goes on the turn row and in events.
    log.warn({ conversationId, reason: plan.reason }, "claude turn fell back");
    await finishTurn(turn.id, {
      status: "failed",
      error: `${plan.reason}: ${plan.message}`,
      ...audit(),
      ...(plan.sessionId !== undefined && { sessionId: plan.sessionId }),
      ...(plan.structuredOutput !== undefined && { structuredOutput: plan.structuredOutput }),
    });
    const r = await runFallbackTurn({ conversation, pending, reason: plan.reason });
    return { turnId: r.turn.id, outcome: "fallback" };
  }

  // From here the reply goes out, so a throw propagates: a fallback after the send would be a second reply.
  const { guarded: g, first } = plan;
  // Counts and handle-shaped values only, in events and logs: the reply and its digits stay out of them.
  if (g.scrubbed) {
    await note(conversationId, "scrub_strip", { turnId: turn.id, runs: g.foreignRuns, drops: g.digitDrops });
    log.warn({ conversationId, runs: g.foreignRuns, drops: g.digitDrops }, "stripped model-typed digits");
  }
  if (g.replaced) {
    await note(conversationId, "dispatch_language_strip", { turnId: turn.id });
    log.warn({ conversationId }, "replaced dispatch language");
  }
  if (g.restored > 0) {
    await note(conversationId, "number_restored", { turnId: turn.id, count: g.restored });
    log.warn({ conversationId, count: g.restored }, "sent again numbers the reply lacked");
  }
  if (g.unknownHandles.length > 0) await note(conversationId, "unknown_handle", { turnId: turn.id, handles: g.unknownHandles });
  if (g.staleHandles.length > 0) await note(conversationId, "stale_handle", { turnId: turn.id, handles: g.staleHandles });

  const message = await deliverText(conversation, { text: g.text, template: g.template, origin: "agent", turnId: turn.id });
  await markAnswered(pending.map((m) => m.id), turn.id);
  // A reply that was not delivered stays visible: the turn is failed, and deliverText flagged the conversation.
  const delivered = message.deliveryStatus !== "failed";
  await finishTurn(turn.id, {
    status: delivered ? "ok" : "failed",
    error: delivered ? null : "delivery_failed",
    structuredOutput: g.droppedSyntax.length > 0 ? { ...g.structured, droppedSyntax: g.droppedSyntax } : g.structured,
    ...audit(),
    sessionId: first.sessionId,
    model: first.model ?? cfg.claude.model,
    scrubbed: g.scrubbed,
  });
  // Claude's own report of the language. The flag goes through flagConversation, so a reason already set is kept.
  await updateConversation(conversationId, { language: g.structured.language });
  if (g.structured.needs_human) await flagConversation(conversationId, "needs_human");
  if (delivered) await recordOkTurn();
  return { turnId: turn.id, outcome: delivered ? "ok" : "failed" };
}
