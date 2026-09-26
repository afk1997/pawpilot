import { describe, it, expect } from "vitest";
import { buildChildEnv, classifyOutcome } from "@/server/agent/claude-code-backend";

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
});

describe("buildChildEnv", () => {
  const parent: NodeJS.ProcessEnv = {
    NODE_ENV: "test", PATH: "/usr/bin", HOME: "/Users/owner", ANTHROPIC_API_KEY: "sk-test", CLAUDECODE: "1",
    CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_EFFORT: "max", UNSET: undefined,
  };
  it("copies the base without the API key and parent-session variables, and isolates HOME and the config dir", () => {
    const env = buildChildEnv(parent, { homeDir: "/opt/arham/claude-home" });
    for (const key of ["ANTHROPIC_API_KEY", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_EFFORT", "UNSET"]) {
      expect(Object.hasOwn(env, key)).toBe(false);
    }
    expect(Object.values(env).every((v) => typeof v === "string")).toBe(true);
    expect(env).toMatchObject({ NODE_ENV: "test", PATH: "/usr/bin", HOME: "/opt/arham/claude-home", CLAUDE_CONFIG_DIR: "/opt/arham/claude-home/config" });
    expect(parent.ANTHROPIC_API_KEY).toBe("sk-test");
  });
  it("sets the OAuth token only when one is given", () => {
    expect(buildChildEnv(parent, { homeDir: "/h", oauthToken: "oauth-test" }).CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-test");
    expect(Object.hasOwn(buildChildEnv(parent, { homeDir: "/h" }), "CLAUDE_CODE_OAUTH_TOKEN")).toBe(false);
  });
});
