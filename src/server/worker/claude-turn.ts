import type { Conversation, Message } from "../db/schema";
import { getConfig } from "../config";
import { log, safeErrorFields } from "../log";
import type { Language } from "../types";
import { getBackend } from "../agent";
import type { BackendErrorKind, LLMBackend, ObservedToolUse, TurnResult } from "../agent/types";
import { HandleRegistry } from "../agent/handles";
import { createArhamTools, SERVER_NAME, type ToolCallRecord, type ToolContext } from "../agent/tools";
import { buildSystemPrompt, buildTurnPrompt, formatIst } from "../agent/prompt";
import { renderTranscript } from "../agent/transcript";
import { findDigitRuns } from "../agent/scrub";
import { guardReply, type CorrectionPurpose, type GuardedReply } from "../agent/guards";
import { getCoverageSummary } from "../directory/coverage";
import { getAmbulancesByIds, getClinicsByIds } from "../directory/repo";
import { getStaticPhones } from "../content/static";
import { recordEvent } from "../inbound/store";
import { lastKnownLocation, loadHistory, sharedHandles } from "./gather";
import { deliverText } from "./deliver";
import { createTurn, finishTurn, flagConversation, loadConversationHandles, markAnswered, updateConversation } from "./persist";
import { isClaudePaused, pauseClaude, recordOkTurn } from "./pause";
import { runFallbackTurn } from "./fallback";

/** The wall-clock budget for a turn's backend calls, less a reserve for rendering, the send or the fallback. */
export const TURN_BUDGET_MS = 100_000;
const TURN_RESERVE_MS = 10_000;
/** A call with less time than this left is skipped: it would likely time out, and the fallback is quicker. */
const MIN_CALL_MS = 15_000;
/** How long Claude stays paused after AUTH, or after LIMITED without a reset time. */
const PAUSE_FALLBACK_MS = 15 * 60 * 1000;
/** The transcript's length in messages, and the shorter one an INVALID_OUTPUT retry gets. */
const TRANSCRIPT_LIMIT = 30;
const SHORT_TRANSCRIPT_LIMIT = 10;
/** Why a backend call is made: the first, the retry of a failed one, or a guard's correction. */
type CallPurpose = "first" | "retry" | CorrectionPurpose;
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
    const handlesShared = await sharedHandles(history, reg);

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
