import { describe, it, expect } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { DISALLOWED_TOOLS, buildChildEnv, classifyOutcome, observe, type StreamObservation } from "@/server/agent/claude-code-backend";
import type { ObservedToolUse } from "@/server/agent/types";

const success = (structured_output: unknown, extra: Record<string, unknown> = {}) => ({
  type: "result", subtype: "success", is_error: false, duration_ms: 1000, duration_api_ms: 900, num_turns: 2, result: "",
  stop_reason: "end_turn", total_cost_usd: 0.01, usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: { "claude-sonnet-5": { costUSD: 0.01 } },
  permission_denials: [], uuid: "u", session_id: "s", structured_output, ...extra,
});
const good = { reply: "hi", language: "en", intent: "smalltalk", location: { city: null, area: null }, needs_human: false, notes: null };
const base = { rejectedLimit: null, assistantError: null, result: null, aborted: false, thrown: null, latencyMs: 5 };

describe("classifyOutcome", () => {
  it("returns ok with the parsed reply, session id, model and cost", () => {
    const r = classifyOutcome({ ...base, result: success(good) as never });
    expect(r.ok && r.structured.reply).toBe("hi");
    expect(r.ok && r.sessionId).toBe("s");
    expect(r.ok && r.model).toBe("claude-sonnet-5");
    expect(r.ok && r.costUsd).toBe(0.01);
  });
  it("flags invalid structured output", () => {
    expect(classifyOutcome({ ...base, result: success({ reply: "" }) as never })).toMatchObject({ ok: false, kind: "INVALID_OUTPUT" });
    expect(classifyOutcome({ ...base, result: { ...success(good), subtype: "error_max_structured_output_retries", errors: [] } as never })).toMatchObject({ ok: false, kind: "INVALID_OUTPUT" });
  });
  it("maps a rejected rate limit to LIMITED with the reset time", () => {
    const r = classifyOutcome({ ...base, rejectedLimit: { resetsAt: 1_800_000_000 }, result: success(good) as never });
    expect(r).toMatchObject({ ok: false, kind: "LIMITED" });
    expect(!r.ok && r.retryAfter?.getTime()).toBe(1_800_000_000 * 1000);
  });
  it("maps assistant errors", () => {
    expect(classifyOutcome({ ...base, assistantError: "rate_limit" })).toMatchObject({ ok: false, kind: "LIMITED" });
    expect(classifyOutcome({ ...base, assistantError: "authentication_failed" })).toMatchObject({ ok: false, kind: "AUTH" });
    expect(classifyOutcome({ ...base, assistantError: "billing_error" })).toMatchObject({ ok: false, kind: "AUTH" });
    expect(classifyOutcome({ ...base, assistantError: "overloaded" })).toMatchObject({ ok: false, kind: "TRANSIENT" });
  });
  it("maps error_during_execution by message and api status", () => {
    const err = (errors: string[]) => ({ ...success(good), subtype: "error_during_execution", is_error: true, errors }) as never;
    expect(classifyOutcome({ ...base, result: err(["You've hit your weekly limit · resets 3pm"]) })).toMatchObject({ ok: false, kind: "LIMITED" });
    expect(classifyOutcome({ ...base, result: err(["Not logged in. Run claude login"]) })).toMatchObject({ ok: false, kind: "AUTH" });
    expect(classifyOutcome({ ...base, result: err(["socket hang up"]) })).toMatchObject({ ok: false, kind: "TRANSIENT" });
    expect(classifyOutcome({ ...base, result: success(good, { is_error: true, api_error_status: 429 }) as never })).toMatchObject({ ok: false, kind: "LIMITED" });
    expect(classifyOutcome({ ...base, result: success(good, { is_error: true, api_error_status: 401 }) as never })).toMatchObject({ ok: false, kind: "AUTH" });
  });
  it("treats abort and thrown errors as transient, and no result as transient", () => {
    expect(classifyOutcome({ ...base, aborted: true })).toMatchObject({ ok: false, kind: "TRANSIENT" });
    expect(classifyOutcome({ ...base, thrown: "spawn failed" })).toMatchObject({ ok: false, kind: "TRANSIENT" });
    expect(classifyOutcome(base)).toMatchObject({ ok: false, kind: "TRANSIENT" });
  });
  it("classifies by the result when the SDK also threw or aborted after it", () => {
    // After an error result the child exits non-zero and the SDK throws that result's text again (sdk.mjs readMessages).
    const echoed = "Claude Code returned an error result: retries exhausted";
    const maxRetries = { ...success(good), subtype: "error_max_structured_output_retries", is_error: true, errors: ["retries exhausted"] } as never;
    expect(classifyOutcome({ ...base, result: maxRetries, thrown: echoed })).toMatchObject({ ok: false, kind: "INVALID_OUTPUT" });
    expect(classifyOutcome({ ...base, result: success(good, { is_error: true, api_error_status: 401 }) as never, thrown: echoed })).toMatchObject({ ok: false, kind: "AUTH" });
    expect(classifyOutcome({ ...base, result: success(good) as never, aborted: true })).toMatchObject({ ok: true, sessionId: "s" });
  });
  it("names the failing fields when structured output fails validation, within 300 characters", () => {
    const r = classifyOutcome({ ...base, result: success({ ...good, reply: "", language: "fr" }) as never });
    expect(r).toMatchObject({ ok: false, kind: "INVALID_OUTPUT" });
    expect(!r.ok && r.message).toMatch(/^structured output failed validation: reply: .+; language: .+$/);
    const extras = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`unexpected_key_${i}`, 1]));
    const long = classifyOutcome({ ...base, result: success({ ...good, ...extras }) as never });
    expect(!long.ok && long.message.startsWith("structured output failed validation: (root): ")).toBe(true);
    expect(!long.ok && long.message.length).toBe(300);
  });
  it("carries the session id on failures that have a result message, and null on the others", () => {
    expect(classifyOutcome({ ...base, result: success({ reply: "" }) as never })).toMatchObject({ ok: false, sessionId: "s" });
    expect(classifyOutcome({ ...base, rejectedLimit: {}, result: success(good) as never })).toMatchObject({ ok: false, sessionId: "s" });
    expect(classifyOutcome({ ...base, thrown: "spawn failed" })).toMatchObject({ ok: false, sessionId: null });
  });
  it("passes the observed tool uses through on success and failure, defaulting to none", () => {
    const toolUses = [{ name: "mcp__arham__find_ambulances", isError: false }, { name: "Bash", isError: true }];
    expect(classifyOutcome({ ...base, toolUses, result: success(good) as never })).toMatchObject({ ok: true, toolUses });
    expect(classifyOutcome({ ...base, toolUses, aborted: true })).toMatchObject({ ok: false, kind: "TRANSIENT", toolUses });
    expect(classifyOutcome(base)).toMatchObject({ ok: false, toolUses: [] });
  });
  it("reads limit and auth wording only as whole phrases", () => {
    const err = (text: string) => ({ ...success(good), subtype: "error_during_execution", is_error: true, errors: [text] }) as never;
    expect(classifyOutcome({ ...base, result: err("Failed to generate a separate, accurate answer") })).toMatchObject({ ok: false, kind: "TRANSIENT" });
    expect(classifyOutcome({ ...base, result: err("Claude AI usage limit reached|1800000000") })).toMatchObject({ ok: false, kind: "LIMITED" });
    expect(classifyOutcome({ ...base, result: err("API Error: Rate limit exceeded") })).toMatchObject({ ok: false, kind: "LIMITED" });
    expect(classifyOutcome({ ...base, result: err("Invalid API key · Please run /login") })).toMatchObject({ ok: false, kind: "AUTH" });
    expect(classifyOutcome({ ...base, result: err("Request failed with status 403") })).toMatchObject({ ok: false, kind: "AUTH" });
    expect(classifyOutcome({ ...base, result: err("upstream sent 4031 bytes") })).toMatchObject({ ok: false, kind: "TRANSIENT" });
  });
  it("treats invalid_request and model_not_found as AUTH, since the owner must act", () => {
    expect(classifyOutcome({ ...base, assistantError: "invalid_request" })).toMatchObject({ ok: false, kind: "AUTH" });
    expect(classifyOutcome({ ...base, assistantError: "model_not_found" })).toMatchObject({ ok: false, kind: "AUTH" });
  });
  it("fails the turn as mcp_not_connected when the init check did not pass", () => {
    expect(classifyOutcome({ ...base, initMismatch: true, aborted: true })).toMatchObject({ ok: false, kind: "TRANSIENT", message: "mcp_not_connected" });
  });
  it("cuts every failure message to 300 characters", () => {
    expect(classifyOutcome({ ...base, thrown: "x".repeat(1000) })).toMatchObject({ ok: false, message: "x".repeat(300) });
    const long = classifyOutcome({ ...base, result: { ...success(good), subtype: "error_during_execution", is_error: true, errors: ["socket hang up ".repeat(50)] } as never });
    expect(!long.ok && long.message.length).toBe(300);
  });
  it("answers TRANSIENT, keeping the tool uses, when the observation cannot be read", () => {
    const broken = {
      get subtype(): string {
        throw new Error("malformed result");
      },
    };
    const toolUses = [{ name: "mcp__arham__get_info", isError: false }];
    expect(classifyOutcome({ ...base, toolUses, result: broken as never })).toMatchObject({ ok: false, kind: "TRANSIENT", toolUses });
  });
});

describe("observe", () => {
  const allowed = ["mcp__arham__find_ambulances", "mcp__arham__find_clinics", "mcp__arham__get_info"];
  const expected = { toolNames: allowed, server: "arham" };
  const run = (...msgs: unknown[]): StreamObservation => {
    const obs: StreamObservation = { ...base, toolUses: [] };
    const byId = new Map<string, ObservedToolUse>();
    for (const msg of msgs) observe(msg as SDKMessage, obs, byId, expected);
    return obs;
  };
  const init = (tools: string[], servers = [{ name: "arham", status: "connected" }]) =>
    ({ type: "system", subtype: "init", tools, mcp_servers: servers, session_id: "s", uuid: "u" });
  const assistant = (content: unknown[], error?: string) =>
    ({ type: "assistant", message: { role: "assistant", content }, parent_tool_use_id: null, session_id: "s", uuid: "u", ...(error && { error }) });
  const user = (content: unknown) => ({ type: "user", message: { role: "user", content }, parent_tool_use_id: null, session_id: "s" });
  const limit = (info: Record<string, unknown>) => ({ type: "rate_limit_event", rate_limit_info: info, session_id: "s", uuid: "u" });

  it("pairs tool results with their tool uses by id and flags the errors", () => {
    const obs = run(
      assistant([{ type: "text", text: "looking" }, { type: "tool_use", id: "t1", name: "mcp__arham__find_ambulances", input: {} }]),
      assistant([{ type: "tool_use", id: "t2", name: "Bash", input: {} }]),
      user([{ type: "tool_result", tool_use_id: "t2", is_error: true, content: "denied" }, { type: "tool_result", tool_use_id: "t1", content: "{}" }]),
      user("plain text"),
      user([{ type: "tool_result", tool_use_id: "unknown", is_error: true }]),
    );
    expect(obs.toolUses).toEqual([{ name: "mcp__arham__find_ambulances", isError: false }, { name: "Bash", isError: true }]);
  });
  it("records an assistant error and the result message", () => {
    const result = success(good);
    const obs = run(assistant([], "overloaded"), result);
    expect(obs.assistantError).toBe("overloaded");
    expect(obs.result).toBe(result);
  });
  it("keeps a turn that extra usage covered and says so, and refuses one it did not", () => {
    for (const overageStatus of ["allowed", "allowed_warning"]) {
      const obs = run(limit({ status: "rejected", overageStatus, resetsAt: 1_800_000_000 }), success(good));
      expect(obs).toMatchObject({ rejectedLimit: null, extraUsage: true });
      expect(classifyOutcome(obs)).toMatchObject({ ok: true, extraUsage: true });
    }
    for (const info of [{ status: "rejected" }, { status: "rejected", overageStatus: "rejected" }]) {
      expect(classifyOutcome(run(limit(info), success(good)))).toMatchObject({ ok: false, kind: "LIMITED" });
    }
    expect(classifyOutcome(run(success(good)))).not.toHaveProperty("extraUsage");
  });
  it("reads a reset time given in seconds or in milliseconds", () => {
    const retryAt = (resetsAt: number) => {
      const r = classifyOutcome(run(limit({ status: "rejected", resetsAt })));
      return !r.ok && r.retryAfter?.getTime();
    };
    expect(retryAt(1_800_000_000)).toBe(1_800_000_000_000);
    expect(retryAt(1_800_000_000_000)).toBe(1_800_000_000_000);
  });
  it("keeps a near-limit warning for the log without failing the turn", () => {
    const obs = run(limit({ status: "allowed_warning", utilization: 0.9 }), success(good));
    expect(obs.usageWarning).toMatchObject({ status: "allowed_warning" });
    expect(classifyOutcome(obs)).toMatchObject({ ok: true });
  });
  it("passes an init that lists only the allowed tools and StructuredOutput, with the server connected", () => {
    expect(run(init([...allowed, "StructuredOutput"])).initMismatch).toBeFalsy();
  });
  it("flags an init with a foreign tool, or without the arham server connected", () => {
    expect(run(init([...allowed, "StructuredOutput", "Bash"])).initMismatch).toBe(true);
    expect(run(init(allowed, [])).initMismatch).toBe(true);
    expect(run(init(allowed, [{ name: "arham", status: "pending" }])).initMismatch).toBe(true);
    expect(run(init(allowed, [{ name: "claude_ai_Gmail", status: "connected" }])).initMismatch).toBe(true);
  });
  it("needs no server for a turn without tools", () => {
    const obs: StreamObservation = { ...base, toolUses: [] };
    observe(init(["StructuredOutput"], []) as never, obs, new Map(), { toolNames: [], server: null });
    expect(obs.initMismatch).toBeFalsy();
  });
});

describe("buildChildEnv", () => {
  const parent: NodeJS.ProcessEnv = {
    NODE_ENV: "production", PATH: "/usr/bin", HOME: "/Users/owner", LANG: "en_IN.UTF-8", LC_ALL: "en_IN.UTF-8", LC_CTYPE: "UTF-8",
    TZ: "Asia/Kolkata", TMPDIR: "/tmp", SSL_CERT_FILE: "/etc/ssl/cert.pem", NODE_EXTRA_CA_CERTS: "/etc/ssl/extra.pem",
    HTTP_PROXY: "http://proxy:3128", https_proxy: "http://proxy:3128", NO_PROXY: "localhost",
    DATABASE_URL: "postgres://u:p@db/arham", INTERAKT_API_KEY: "ik", ADMIN_PASSWORD: "pw", SESSION_SECRET: "secret",
    ANTHROPIC_API_KEY: "sk-test", ANTHROPIC_BASE_URL: "https://proxy.example", ANTHROPIC_AUTH_TOKEN: "at",
    CLAUDE_CODE_EFFORT_LEVEL: "max", CLAUDECODE: "1", CLAUDE_CODE_CHILD_SESSION: "1", CLAUDE_CODE_ENTRYPOINT: "cli",
    CLAUDE_EFFORT: "max", CLAUDE_CODE_OAUTH_TOKEN: "parent-token", UNSET: undefined,
  };
  it("passes only locale, time zone, temp dir, CA and proxy variables, and isolates HOME and the config dir", () => {
    expect(buildChildEnv(parent, { homeDir: "/opt/arham/claude-home" })).toEqual({
      PATH: "/usr/bin", LANG: "en_IN.UTF-8", LC_ALL: "en_IN.UTF-8", LC_CTYPE: "UTF-8", TZ: "Asia/Kolkata", TMPDIR: "/tmp",
      SSL_CERT_FILE: "/etc/ssl/cert.pem", NODE_EXTRA_CA_CERTS: "/etc/ssl/extra.pem",
      HTTP_PROXY: "http://proxy:3128", https_proxy: "http://proxy:3128", NO_PROXY: "localhost",
      HOME: "/opt/arham/claude-home", CLAUDE_CONFIG_DIR: "/opt/arham/claude-home/config",
      CLAUDE_CODE_STARTUP_FAILURE_RESULTS: "1", ENABLE_CLAUDEAI_MCP_SERVERS: "false",
    });
    expect(parent.ANTHROPIC_API_KEY).toBe("sk-test");
  });
  it("sets the OAuth token only when one is given, never the parent's", () => {
    expect(buildChildEnv(parent, { homeDir: "/h", oauthToken: "oauth-test" }).CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-test");
    expect(Object.hasOwn(buildChildEnv(parent, { homeDir: "/h" }), "CLAUDE_CODE_OAUTH_TOKEN")).toBe(false);
  });
});

describe("DISALLOWED_TOOLS", () => {
  it("denies the built-in tools and claude.ai connector tools, never this app's own MCP tools", () => {
    expect(DISALLOWED_TOOLS).toEqual(expect.arrayContaining(["Bash", "Read", "Write", "Edit", "WebFetch", "WebSearch", "Task", "mcp__claude_ai_*"]));
    expect(DISALLOWED_TOOLS.filter((t) => t === "mcp__*" || t.startsWith("mcp__arham"))).toEqual([]);
  });
});
