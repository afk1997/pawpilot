import { mkdirSync } from "node:fs";
import { query, type EffortLevel, type SDKMessage, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { REPLY_JSON_SCHEMA, parseStructuredReplyDetailed } from "./schema";
import type { BackendErrorKind, LLMBackend, ObservedToolUse, TurnInput, TurnResult } from "./types";
import { log } from "../log";

export interface StreamObservation {
  rejectedLimit: { resetsAt?: number } | null;
  assistantError: string | null;
  result: SDKResultMessage | null;
  aborted: boolean;
  thrown: string | null;
  latencyMs: number;
  /** Every tool_use the stream showed, in order; absent means none. */
  toolUses?: ObservedToolUse[];
}

const BUILTIN_TOOLS = ["Bash", "Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "WebFetch", "WebSearch", "Task", "NotebookEdit", "TodoWrite", "KillShell", "BashOutput"];
const AUTH_ERRORS = new Set(["authentication_failed", "oauth_org_not_allowed", "account_on_hold", "verification_required", "billing_error", "cloud_credential_error"]);
/**
 * Never inherited by the child: an API key would bill the API instead of the Max plan, and the others belong to a
 * parent Claude Code session (CLAUDE_EFFORT would override the effort option).
 */
const STRIPPED_ENV = ["ANTHROPIC_API_KEY", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_EFFORT"];
const INVALID_OUTPUT_MESSAGE_MAX = 300;

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
 * The whole environment of the Claude Code child (the SDK does not merge it with process.env): `base` without unset
 * values and without STRIPPED_ENV, HOME and the config dir inside homeDir, and the OAuth token when one is given.
 */
export function buildChildEnv(base: NodeJS.ProcessEnv, opts: { homeDir: string; oauthToken?: string }): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined) env[key] = value;
  }
  for (const key of STRIPPED_ENV) delete env[key];
  env.HOME = opts.homeDir;
  env.CLAUDE_CONFIG_DIR = `${opts.homeDir}/config`;
  if (opts.oauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = opts.oauthToken;
  return env;
}

/** Pure mapping from what the SDK stream showed to a TurnResult (spec §5.4 table). */
export function classifyOutcome(obs: StreamObservation): TurnResult {
  const sessionId = obs.result?.session_id ?? null;
  const toolUses = obs.toolUses ?? [];
  const fail = (kind: BackendErrorKind, message: string, retryAfter: Date | null = null): TurnResult =>
    ({ ok: false, kind, message, retryAfter, latencyMs: obs.latencyMs, sessionId, toolUses });

  if (obs.rejectedLimit) return fail("LIMITED", "subscription usage limit reached", resetDate(obs.rejectedLimit.resetsAt));
  if (obs.assistantError) {
    if (obs.assistantError === "rate_limit") return fail("LIMITED", "assistant error: rate_limit");
    if (AUTH_ERRORS.has(obs.assistantError)) return fail("AUTH", `assistant error: ${obs.assistantError}`);
    return fail("TRANSIENT", `assistant error: ${obs.assistantError}`);
  }
  const r = obs.result;
  // The result message is the turn's own verdict. After an error result the child exits non-zero and the SDK throws
  // "Claude Code returned an error result: …", so a throw or an abort decides the class only when no result arrived.
  if (!r) {
    if (obs.thrown) return fail("TRANSIENT", obs.thrown);
    if (obs.aborted) return fail("TRANSIENT", "turn timed out");
    return fail("TRANSIENT", "no result message from the SDK");
  }

  if (r.subtype !== "success") {
    const text = ("errors" in r ? r.errors : []).join(" | ");
    if (r.subtype === "error_max_structured_output_retries" || r.subtype === "error_max_turns") return fail("INVALID_OUTPUT", `${r.subtype}: ${text}`);
    if (/limit|too many requests|rate/i.test(text)) return fail("LIMITED", text);
    if (/not logged in|login|invalid.*token|authentication|unauthorized|401/i.test(text)) return fail("AUTH", text);
    return fail("TRANSIENT", `${r.subtype}: ${text}`);
  }
  if (r.is_error) {
    const status = r.api_error_status ?? 0;
    if (status === 429) return fail("LIMITED", `api status ${status}`);
    if (status === 401 || status === 403) return fail("AUTH", `api status ${status}`);
    return fail("TRANSIENT", `result is_error (status ${status}): ${r.result.slice(0, 200)}`);
  }
  const parsed = parseStructuredReplyDetailed(r.structured_output);
  if (!parsed.ok) {
    return fail("INVALID_OUTPUT", truncate(`structured output failed validation: ${parsed.issues.join("; ")}`, INVALID_OUTPUT_MESSAGE_MAX));
  }
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
  };
}

/**
 * Records the tool_use blocks of an assistant message, and marks one as failed when a user message carries an error
 * tool_result for it. Guards every shape, since a throw here would fail a turn that may have succeeded.
 */
function trackToolUses(msg: SDKMessage, uses: ObservedToolUse[], byId: Map<string, ObservedToolUse>): void {
  if (msg.type === "assistant") {
    const content = msg.message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (block?.type !== "tool_use") continue;
      const use: ObservedToolUse = { name: block.name, isError: false };
      uses.push(use);
      byId.set(block.id, use);
    }
  } else if (msg.type === "user") {
    const content = msg.message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (block?.type !== "tool_result" || block.is_error !== true) continue;
      const use = byId.get(block.tool_use_id);
      if (use) use.isError = true;
    }
  }
}

export class ClaudeCodeBackend implements LLMBackend {
  readonly name = "claude-code";

  constructor(private readonly opts: { model: string; effort: EffortLevel; maxTurns: number; oauthToken?: string; homeDir: string }) {
    mkdirSync(`${opts.homeDir}/config`, { recursive: true });
  }

  async runTurn(input: TurnInput): Promise<TurnResult> {
    const started = Date.now();
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), input.timeoutMs);
    const env = buildChildEnv(process.env, { homeDir: this.opts.homeDir, oauthToken: this.opts.oauthToken });

    const toolUses: ObservedToolUse[] = [];
    const toolUsesById = new Map<string, ObservedToolUse>();
    const obs: StreamObservation = { rejectedLimit: null, assistantError: null, result: null, aborted: false, thrown: null, latencyMs: 0, toolUses };
    try {
      const q = query({
        prompt: input.prompt,
        options: {
          systemPrompt: input.systemPrompt,
          model: this.opts.model,
          effort: this.opts.effort,
          maxTurns: this.opts.maxTurns,
          mcpServers: input.toolServer ? { arham: input.toolServer } : {},
          allowedTools: input.allowedToolNames,
          disallowedTools: BUILTIN_TOOLS,
          tools: [],
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          settingSources: [],
          persistSession: false,
          strictMcpConfig: true,
          outputFormat: { type: "json_schema", schema: REPLY_JSON_SCHEMA },
          cwd: this.opts.homeDir,
          env,
          abortController: abort,
          stderr: (data) => log.debug({ data: data.slice(0, 200) }, "claude stderr"),
        },
      });
      for await (const msg of q) {
        trackToolUses(msg, toolUses, toolUsesById);
        if (msg.type === "rate_limit_event") {
          const info = msg.rate_limit_info;
          if (info.status === "rejected") obs.rejectedLimit = { resetsAt: info.resetsAt };
          else if (info.status === "allowed_warning") log.warn({ info }, "claude usage nearing limit");
        } else if (msg.type === "assistant" && msg.error) {
          obs.assistantError = msg.error;
        } else if (msg.type === "result") {
          obs.result = msg;
        }
      }
    } catch (e) {
      if (abort.signal.aborted) obs.aborted = true;
      else obs.thrown = e instanceof Error ? e.message : String(e);
    } finally {
      clearTimeout(timer);
    }
    obs.latencyMs = Date.now() - started;
    const outcome = classifyOutcome(obs);
    // Kind and latency only: the message can quote SDK error text or reply field names, so it goes on the turn row.
    if (!outcome.ok) log.warn({ kind: outcome.kind, latencyMs: outcome.latencyMs }, "claude turn failed");
    return outcome;
  }
}
