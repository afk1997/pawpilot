import { chmodSync, mkdirSync } from "node:fs";
import {
  query, type EffortLevel, type SDKMessage, type SDKRateLimitInfo, type SDKResultMessage, type SDKStartupFailureReason,
} from "@anthropic-ai/claude-agent-sdk";
import { REPLY_JSON_SCHEMA, parseStructuredReplyDetailed } from "./schema";
import { SERVER_NAME } from "./tools";
import type { BackendErrorKind, LLMBackend, ObservedToolUse, TurnInput, TurnResult } from "./types";
import { log, safeErrorFields } from "../log";

export interface StreamObservation {
  /** A usage limit the turn met: a rejection extra usage did not pay for, or one it paid for that is not allowed. */
  rejectedLimit: { resetsAt?: number } | null;
  assistantError: string | null;
  result: SDKResultMessage | null;
  aborted: boolean;
  thrown: string | null;
  latencyMs: number;
  /** Every tool_use the stream showed, in order; absent means none. */
  toolUses?: ObservedToolUse[];
  /** The plan's limit was reached but extra usage (overage) paid for the turn, so it ran. */
  extraUsage?: boolean;
  /** The last near-limit warning, logged once after the turn. */
  usageWarning?: SDKRateLimitInfo;
  /** An init message arrived. */
  sawInit?: boolean;
  /** An assistant frame ended with stop_reason "refusal": the model refused this turn's content. */
  refusal?: boolean;
  /** What the init message got wrong (foreign or missing tools, and the server's status); absent when it matched. */
  initMismatch?: string;
}

/** Whether extra usage (overage) may pay for a turn past the plan's limit: LLM_ALLOW_EXTRA_USAGE. */
export interface UsagePolicy {
  allowExtraUsage: boolean;
}

/** What a turn's init message must show. */
export interface ExpectedSetup {
  /** The tools it must list, and the only ones besides the CLI's StructuredOutput. */
  toolNames: readonly string[];
  /** The MCP server it must show as connected; null for a turn without tools. */
  server: string | null;
}

const BUILTIN_TOOLS = ["Bash", "Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "WebFetch", "WebSearch", "Task", "NotebookEdit", "TodoWrite", "KillShell", "BashOutput"];
/**
 * Tools the child may never call: every built-in, and any claude.ai connector tool (the CLI matches a deny rule's "*"
 * against the whole tool name). The connector rule is belt-and-braces: strictMcpConfig already keeps connectors from
 * loading. Never "mcp__*", which would also deny this app's own tools.
 */
export const DISALLOWED_TOOLS = [...BUILTIN_TOOLS, "mcp__claude_ai_*"];
/** Assistant errors only the owner can clear (login, account or model); the turn runner pauses Claude. */
const AUTH_ERRORS = new Set([
  "authentication_failed", "oauth_org_not_allowed", "account_on_hold", "verification_required", "billing_error", "cloud_credential_error",
  "model_not_found",
]);
/** Error text that means a usage limit, and error text that means a login problem; whole phrases only. */
const LIMIT_TEXT_RE = /\b(rate limit|usage limit|weekly limit|too many requests|limit reached|hit your limit)\b/i;
const AUTH_TEXT_RE = /\b(not logged in|invalid api key|invalid token|authentication(?:_error)?|authenticate|permission_error|unauthorized|401|403)\b/i;
/**
 * Endings the turn's own content caused (a prompt too long for the model, a context that keeps refilling): a retry with
 * a shorter transcript can clear them.
 */
const CONTENT_ENDINGS = new Set<string>(["prompt_too_long", "blocking_limit", "rapid_refill_breaker"]);
/** Result text that means the turn's tool history was malformed: this turn's problem, not the service's. */
const TOOL_HISTORY_RE = /orphaned tool_result|duplicate tool_use|tool use concurrency/i;
/** Startup failures only the owner can fix (install, config, login, host); the others are read by their text. */
const OWNER_STARTUP_FAILURES = new Set<SDKStartupFailureReason>([
  "org_pin_api_key_conflict", "org_pin_mismatch", "managed_settings_invalid", "gateway_signin_required", "gateway_access_denied",
  "proxy_invalid", "temp_dir_unusable", "cwd_unavailable", "shell_tool_missing", "cli_version_too_old", "bypass_root",
]);
/** The tool the CLI adds to carry the reply when outputFormat is a JSON schema. */
const STRUCTURED_OUTPUT_TOOL = "StructuredOutput";
/**
 * The only parent variables the child sees: the search path, locale, time zone, temp dir, CA certificates and proxies.
 * Everything else (database URL, API keys, admin secrets, a parent Claude Code session's variables) stays behind.
 */
const INHERITED_ENV = new Set([
  "PATH", "LANG", "TZ", "TMPDIR", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
]);
/** The longest failure message a TurnResult carries. */
const MESSAGE_MAX = 300;

function resetDate(resetsAt?: number): Date | null {
  if (!resetsAt) return null;
  return new Date(resetsAt > 1e12 ? resetsAt : resetsAt * 1000);
}

/** The first `max` code points of `s`, so a cut never splits a surrogate pair. */
function truncate(s: string, max: number): string {
  const points = Array.from(s);
  return points.length > max ? points.slice(0, max).join("") : s;
}

/**
 * The whole environment of the Claude Code child (the SDK does not merge it with process.env): the INHERITED_ENV and
 * LC_* variables of `base`, HOME and the config dir inside homeDir, startup failures reported as result messages,
 * claude.ai connectors off, and the OAuth token when one is given (never the parent's).
 */
export function buildChildEnv(base: NodeJS.ProcessEnv, opts: { homeDir: string; oauthToken?: string }): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && (INHERITED_ENV.has(key) || key.startsWith("LC_"))) env[key] = value;
  }
  env.HOME = opts.homeDir;
  env.CLAUDE_CONFIG_DIR = `${opts.homeDir}/config`;
  env.CLAUDE_CODE_STARTUP_FAILURE_RESULTS = "1";
  env.ENABLE_CLAUDEAI_MCP_SERVERS = "false";
  if (opts.oauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = opts.oauthToken;
  return env;
}

/**
 * Folds one stream message into the observation: the init check, rate-limit events, assistant errors, tool uses and
 * their results (paired by id through byId), and the result message. Pure apart from its arguments, and guarded
 * against unexpected shapes, since a throw here would fail a turn that may have succeeded.
 */
export function observe(
  msg: SDKMessage, obs: StreamObservation, byId: Map<string, ObservedToolUse>, expected: ExpectedSetup, policy: UsagePolicy,
): void {
  switch (msg.type) {
    case "system": {
      if (msg.subtype !== "init") return;
      obs.sawInit = true;
      const listed: unknown[] = Array.isArray(msg.tools) ? msg.tools : [];
      const servers: unknown[] = Array.isArray(msg.mcp_servers) ? msg.mcp_servers : [];
      const foreign = listed.filter((t) => t !== STRUCTURED_OUTPUT_TOOL && !expected.toolNames.includes(t as string)).map(String);
      const missing = expected.toolNames.filter((t) => !listed.includes(t));
      let status: string | null = null;
      if (expected.server !== null) {
        const found = servers.find((s) => (s as { name?: unknown } | null)?.name === expected.server) as { status?: unknown } | undefined;
        status = typeof found?.status === "string" ? found.status : "absent";
      }
      if (foreign.length === 0 && missing.length === 0 && (status === null || status === "connected")) return;
      obs.initMismatch = [
        ...(foreign.length > 0 ? [`foreign tools [${foreign.join(", ")}]`] : []),
        ...(missing.length > 0 ? [`missing tools [${missing.join(", ")}]`] : []),
        ...(status !== null ? [`${expected.server} status=${status}`] : []),
      ].join("; ");
      return;
    }
    case "rate_limit_event": {
      const info = msg.rate_limit_info;
      if (info?.status === "rejected") {
        // Extra usage (overage) pays for a turn past the plan's limit: the turn runs, so it is not a refusal. When extra
        // usage is not allowed, the limit still counts: classify keeps the reply and asks for a pause until the reset.
        const overage = info.overageStatus === "allowed" || info.overageStatus === "allowed_warning";
        if (overage) obs.extraUsage = true;
        if (!overage || !policy.allowExtraUsage) obs.rejectedLimit = { resetsAt: info.resetsAt };
      } else if (info?.status === "allowed_warning") {
        obs.usageWarning = info;
      }
      return;
    }
    case "assistant": {
      if (msg.error) obs.assistantError = msg.error;
      if (msg.message?.stop_reason === "refusal") obs.refusal = true;
      const content = msg.message?.content;
      if (!Array.isArray(content)) return;
      for (const block of content) {
        if (block?.type !== "tool_use") continue;
        const use: ObservedToolUse = { name: block.name, isError: false };
        (obs.toolUses ??= []).push(use);
        byId.set(block.id, use);
      }
      return;
    }
    case "user": {
      const content = msg.message?.content;
      if (!Array.isArray(content)) return;
      for (const block of content) {
        if (block?.type !== "tool_result" || block.is_error !== true) continue;
        const use = byId.get(block.tool_use_id);
        if (use) use.isError = true;
      }
      return;
    }
    case "result":
      obs.result = msg;
      return;
  }
}

/** The reply the turn produced: no assistant error, a success result that is not an error, and output that validates. */
function validReply(obs: StreamObservation): boolean {
  const r = obs.result;
  return !obs.assistantError && r?.subtype === "success" && !r.is_error && parseStructuredReplyDetailed(r.structured_output).ok;
}

function classify(obs: StreamObservation): TurnResult {
  const sessionId = obs.result?.session_id ?? null;
  const toolUses = obs.toolUses ?? [];
  const fail = (kind: BackendErrorKind, message: string, retryAfter: Date | null = null): Extract<TurnResult, { ok: false }> => ({
    ok: false, kind, message: truncate(message, MESSAGE_MAX), retryAfter, latencyMs: obs.latencyMs, sessionId, toolUses,
    ...(obs.extraUsage && { extraUsage: true }),
  });

  // The turn was aborted at init, before the model ran: nothing else in the observation counts.
  if (obs.initMismatch) return fail("TRANSIENT", `mcp_not_connected: ${obs.initMismatch}`);
  // A limit decides the class unless a valid reply arrived anyway: that reply is kept (time to number), and the ok
  // result below asks for the pause instead.
  if (obs.rejectedLimit && !validReply(obs)) return fail("LIMITED", "subscription usage limit reached", resetDate(obs.rejectedLimit.resetsAt));
  const r = obs.result;
  if (obs.assistantError) {
    if (obs.assistantError === "rate_limit") return fail("LIMITED", "assistant error: rate_limit");
    // CLI 2.1.282 reports several causes as invalid_request. Only the turn's own content (a refusal, a prompt too long
    // for the model) is this turn's problem, retried with a shorter transcript instead of pausing every conversation.
    // The API status decides next; anything else (a CLI too old, a bad credential header, a plan mismatch) is the owner's.
    if (obs.assistantError === "invalid_request") {
      const status = r?.subtype === "success" ? (r.api_error_status ?? null) : null;
      const ending = r?.terminal_reason;
      if (status === 401 || status === 403) return fail("AUTH", `assistant error: invalid_request (api status ${status})`);
      if (status === 429) return fail("LIMITED", `assistant error: invalid_request (api status ${status})`);
      if (obs.refusal) return fail("INVALID_OUTPUT", "assistant error: invalid_request (refusal)");
      if (ending && CONTENT_ENDINGS.has(ending)) return fail("INVALID_OUTPUT", `assistant error: invalid_request (${ending})`);
      return fail("AUTH", "assistant error: invalid_request");
    }
    if (AUTH_ERRORS.has(obs.assistantError)) return fail("AUTH", `assistant error: ${obs.assistantError}`);
    return fail("TRANSIENT", `assistant error: ${obs.assistantError}`);
  }
  // The result message is the turn's own verdict. After an error result the child exits non-zero and the SDK throws
  // "Claude Code returned an error result: …", so a throw or an abort decides the class only when no result arrived.
  if (!r) {
    if (obs.thrown) return fail("TRANSIENT", obs.thrown);
    if (obs.aborted) return { ...fail("TRANSIENT", "turn timed out"), timedOut: true };
    return fail("TRANSIENT", "no result message from the SDK");
  }

  if (r.subtype !== "success") {
    const text = ("errors" in r ? r.errors : []).join(" | ");
    const reason = r.startup_failure_reason;
    // Every message keeps the startup failure's reason when there is one.
    const said = (what: string) => (reason ? `startup failure ${reason}: ${what}` : what);
    // An owner-fixable startup failure is AUTH whatever its text says; any other one is read like any error text.
    if (reason && OWNER_STARTUP_FAILURES.has(reason)) return fail("AUTH", said(text));
    if (r.subtype === "error_max_structured_output_retries" || r.subtype === "error_max_turns") return fail("INVALID_OUTPUT", `${r.subtype}: ${text}`);
    if (r.terminal_reason && CONTENT_ENDINGS.has(r.terminal_reason)) return fail("INVALID_OUTPUT", `${r.subtype} (${r.terminal_reason}): ${text}`);
    if (LIMIT_TEXT_RE.test(text)) return fail("LIMITED", said(text));
    if (AUTH_TEXT_RE.test(text)) return fail("AUTH", said(text));
    return fail("TRANSIENT", reason ? said(text) : `${r.subtype}: ${text}`);
  }
  if (r.is_error) {
    const status = r.api_error_status ?? 0;
    if (status === 429) return fail("LIMITED", `api status ${status}`);
    if (status === 401 || status === 403) return fail("AUTH", `api status ${status}`);
    // The turn's own content: an ending it caused, or a malformed tool history. A retry with a shorter transcript.
    if (r.terminal_reason && CONTENT_ENDINGS.has(r.terminal_reason)) return fail("INVALID_OUTPUT", `result is_error (${r.terminal_reason}): ${r.result}`);
    if (TOOL_HISTORY_RE.test(r.result)) return fail("INVALID_OUTPUT", `result is_error (tool history): ${r.result}`);
    return fail("TRANSIENT", `result is_error (status ${status}): ${r.result}`);
  }
  const parsed = parseStructuredReplyDetailed(r.structured_output);
  if (!parsed.ok) return fail("INVALID_OUTPUT", `structured output failed validation: ${parsed.issues.join("; ")}`);
  const modelNames = Object.keys(r.modelUsage ?? {});
  const primary = modelNames.find((m) => !/haiku/i.test(m)) ?? modelNames[0] ?? null;
  return {
    ok: true,
    structured: parsed.data,
    usage: (r.usage as unknown as Record<string, unknown>) ?? null,
    latencyMs: obs.latencyMs,
    sessionId,
    model: primary,
    costUsd: typeof r.total_cost_usd === "number" ? r.total_cost_usd : null,
    toolUses,
    ...(obs.extraUsage && { extraUsage: true }),
    ...(obs.rejectedLimit && { pauseUntil: resetDate(obs.rejectedLimit.resetsAt) }),
  };
}

/** Pure mapping from what the SDK stream showed to a TurnResult (spec §5.4 table). Never throws: a malformed observation is TRANSIENT. */
export function classifyOutcome(obs: StreamObservation): TurnResult {
  try {
    return classify(obs);
  } catch {
    return {
      ok: false,
      kind: "TRANSIENT",
      message: "outcome classification failed",
      retryAfter: null,
      latencyMs: typeof obs?.latencyMs === "number" ? obs.latencyMs : 0,
      sessionId: null,
      toolUses: Array.isArray(obs?.toolUses) ? obs.toolUses : [],
    };
  }
}

export class ClaudeCodeBackend implements LLMBackend {
  readonly name = "claude-code";
  /** Set once the home dir has been restricted (or that failed and was logged), so it happens once per backend. */
  private homeRestricted = false;

  constructor(
    private readonly opts: { model: string; effort: EffortLevel; maxTurns: number; oauthToken?: string; homeDir: string; allowExtraUsage: boolean },
  ) {
    // A root worker gives a turn that goes wrong the whole container.
    if (process.getuid?.() === 0) log.warn("worker runs as root; run the container as a non-root user");
  }

  async runTurn(input: TurnInput): Promise<TurnResult> {
    const started = Date.now();
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), input.timeoutMs);
    const obs: StreamObservation = { rejectedLimit: null, assistantError: null, result: null, aborted: false, thrown: null, latencyMs: 0, toolUses: [] };
    const byId = new Map<string, ObservedToolUse>();
    const expected: ExpectedSetup = { toolNames: input.allowedToolNames, server: input.toolServer ? SERVER_NAME : null };
    const policy: UsagePolicy = { allowExtraUsage: this.opts.allowExtraUsage };
    try {
      // Here, not in the constructor: a home dir the worker cannot create fails this turn as TRANSIENT (retry, then
      // fallback) instead of throwing out of getBackend().
      mkdirSync(`${this.opts.homeDir}/config`, { recursive: true, mode: 0o700 });
      this.restrictHome();
      const q = query({
        prompt: input.prompt,
        options: {
          systemPrompt: input.systemPrompt,
          model: this.opts.model,
          effort: this.opts.effort,
          maxTurns: this.opts.maxTurns,
          mcpServers: input.toolServer ? { [SERVER_NAME]: input.toolServer } : {},
          allowedTools: input.allowedToolNames,
          disallowedTools: DISALLOWED_TOOLS,
          tools: [],
          // Denies every tool call allowedTools does not pre-approve, and unlike bypassPermissions it runs as root too.
          // The CLI's StructuredOutput tool is not in allowedTools; it returned the reply under dontAsk against a local
          // stand-in API (CLI 2.1.282), and the owner's smoke run must confirm that against Claude.
          permissionMode: "dontAsk",
          settingSources: [],
          persistSession: false,
          strictMcpConfig: true,
          // Reporter text is in the prompt: never expand an @path mention or run a slash command from it.
          verbatimPrompts: true,
          outputFormat: { type: "json_schema", schema: REPLY_JSON_SCHEMA },
          cwd: this.opts.homeDir,
          env: buildChildEnv(process.env, { homeDir: this.opts.homeDir, oauthToken: this.opts.oauthToken }),
          abortController: abort,
          stderr: (data) => log.debug({ data: data.slice(0, 200) }, "claude stderr"),
        },
      });
      for await (const msg of q) {
        observe(msg, obs, byId, expected, policy);
        if (obs.initMismatch) {
          abort.abort();
          break;
        }
      }
    } catch (e) {
      if (abort.signal.aborted) obs.aborted = true;
      else obs.thrown = e instanceof Error ? e.message : String(e);
    } finally {
      clearTimeout(timer);
    }
    obs.latencyMs = Date.now() - started;
    if (obs.usageWarning) log.warn({ info: obs.usageWarning }, "claude usage nearing limit");
    // The init check never ran for this turn.
    if (obs.result && !obs.sawInit) log.warn({ latencyMs: obs.latencyMs }, "claude result arrived without an init message");
    const outcome = classifyOutcome(obs);
    // Kind and latency only: the message can quote SDK error text or reply field names, so it goes on the turn row.
    if (!outcome.ok) log.warn({ kind: outcome.kind, latencyMs: outcome.latencyMs }, "claude turn failed");
    if (outcome.extraUsage) log.warn({ latencyMs: outcome.latencyMs }, "claude turn used extra usage");
    return outcome;
  }

  /**
   * mkdirSync's mode applies only to directories it creates, so a home dir that already existed is tightened to 0700
   * here, once per backend. A failure (a dir the worker does not own) is logged and the turn goes on.
   */
  private restrictHome(): void {
    if (this.homeRestricted) return;
    this.homeRestricted = true;
    try {
      chmodSync(this.opts.homeDir, 0o700);
    } catch (e) {
      log.warn(safeErrorFields(e), "could not restrict the Claude home dir to 0700");
    }
  }
}
