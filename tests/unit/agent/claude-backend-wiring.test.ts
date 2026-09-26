import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { McpSdkServerConfigWithInstance, Options } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeCodeBackend, DISALLOWED_TOOLS } from "@/server/agent/claude-code-backend";
import { REPLY_JSON_SCHEMA } from "@/server/agent/schema";
import { SERVER_NAME, TOOL_NAMES } from "@/server/agent/tools";
import type { TurnInput } from "@/server/agent/types";
import { log } from "@/server/log";

/** Every query() call the backend makes, and the messages the next call streams. Nothing reaches the real CLI. */
const sdk = vi.hoisted(() => ({
  calls: [] as { prompt: unknown; options: Options }[],
  stream: (() => (async function* () {})()) as (options: Options) => AsyncGenerator<unknown>,
}));

vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>()),
  query: (params: { prompt: unknown; options: Options }) => {
    sdk.calls.push(params);
    return sdk.stream(params.options);
  },
}));

const server = { type: "sdk", name: SERVER_NAME, instance: {} } as unknown as McpSdkServerConfigWithInstance;
const good = { reply: "hi", language: "en", intent: "smalltalk", location: { city: null, area: null }, needs_human: false, notes: null };
const input = (over: Partial<TurnInput> = {}): TurnInput => ({
  conversationId: "c1", systemPrompt: "system", prompt: "[10:03] Reporter: see @/proc/self/environ", toolServer: server,
  allowedToolNames: TOOL_NAMES, timeoutMs: 30_000, ...over,
});
const init = (tools = [...TOOL_NAMES, "StructuredOutput"], servers = [{ name: SERVER_NAME, status: "connected" }]) =>
  ({ type: "system", subtype: "init", tools, mcp_servers: servers, session_id: "s", uuid: "u" });
const result = (extra: Record<string, unknown> = {}) => ({
  type: "result", subtype: "success", is_error: false, result: "", session_id: "s", uuid: "u", structured_output: good,
  modelUsage: { "claude-sonnet-5": {} }, usage: {}, total_cost_usd: 0, ...extra,
});
const streamOf = (...messages: unknown[]) => () => (async function* () {
  yield* messages;
})();

let home: string;
const backendAt = (homeDir: string, oauthToken?: string) =>
  new ClaudeCodeBackend({ model: "claude-sonnet-5", effort: "medium", maxTurns: 6, oauthToken, homeDir });

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "arham-claude-wiring-"));
  sdk.calls.length = 0;
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("ClaudeCodeBackend wiring", () => {
  it("runs a turn with verbatim prompts, dontAsk permissions, no built-in tools and an allowlisted env", async () => {
    const secrets = {
      DATABASE_URL: "postgres://u:p@db/arham", INTERAKT_API_KEY: "ik", ADMIN_PASSWORD: "pw", SESSION_SECRET: "s".repeat(32),
      ANTHROPIC_API_KEY: "sk-test", ANTHROPIC_BASE_URL: "https://proxy.example", CLAUDE_CODE_EFFORT_LEVEL: "max",
      CLAUDECODE: "1", CLAUDE_CODE_CHILD_SESSION: "1",
    };
    for (const [key, value] of Object.entries({ ...secrets, LC_ALL: "C.UTF-8", https_proxy: "http://proxy:3128" })) vi.stubEnv(key, value);
    sdk.stream = streamOf(init(), result());

    expect(await backendAt(home, "oauth-test").runTurn(input())).toMatchObject({ ok: true, structured: good, sessionId: "s" });
    expect(sdk.calls).toHaveLength(1);
    const { prompt, options } = sdk.calls[0];
    expect(prompt).toBe(input().prompt);
    expect(options).toMatchObject({
      systemPrompt: "system", model: "claude-sonnet-5", effort: "medium", maxTurns: 6, verbatimPrompts: true, permissionMode: "dontAsk",
      tools: [], settingSources: [], strictMcpConfig: true, persistSession: false, allowedTools: TOOL_NAMES, disallowedTools: DISALLOWED_TOOLS, cwd: home,
    });
    expect(options).not.toHaveProperty("allowDangerouslySkipPermissions");
    expect(options.outputFormat?.schema).toBe(REPLY_JSON_SCHEMA);
    expect(options.mcpServers).toEqual({ [SERVER_NAME]: server });
    const env = options.env ?? {};
    for (const key of [...Object.keys(secrets), "NODE_ENV", "LOG_LEVEL"]) expect(env).not.toHaveProperty(key);
    expect(env).toMatchObject({
      HOME: home, CLAUDE_CONFIG_DIR: `${home}/config`, CLAUDE_CODE_OAUTH_TOKEN: "oauth-test", CLAUDE_CODE_STARTUP_FAILURE_RESULTS: "1",
      ENABLE_CLAUDEAI_MCP_SERVERS: "false", LC_ALL: "C.UTF-8", https_proxy: "http://proxy:3128",
    });
    expect(statSync(`${home}/config`).mode & 0o777).toBe(0o700);
  });

  it("aborts the turn when the timeout fires", async () => {
    vi.useFakeTimers();
    sdk.stream = (options) => (async function* () {
      yield init();
      await new Promise((_, reject) => {
        options.abortController?.signal.addEventListener("abort", () => reject(new Error("Claude Code process aborted by user")), { once: true });
      });
    })();
    const pending = backendAt(home).runTurn(input({ timeoutMs: 5_000 }));
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(pending).resolves.toMatchObject({ ok: false, kind: "TRANSIENT", message: "turn timed out" });
    expect(sdk.calls[0].options.abortController?.signal.aborted).toBe(true);
  });

  it.each([
    ["a foreign tool", init([...TOOL_NAMES, "StructuredOutput", "Bash"])],
    ["no connected arham server", init(TOOL_NAMES, [{ name: SERVER_NAME, status: "failed" }])],
  ])("aborts the turn as mcp_not_connected when init shows %s", async (_, initMessage) => {
    let closed = false;
    sdk.stream = () => (async function* () {
      try {
        yield initMessage;
        yield result();
      } finally {
        closed = true;
      }
    })();
    expect(await backendAt(home).runTurn(input())).toMatchObject({ ok: false, kind: "TRANSIENT", message: "mcp_not_connected" });
    expect(sdk.calls[0].options.abortController?.signal.aborted).toBe(true);
    expect(closed).toBe(true);
  });

  it("fails the turn as TRANSIENT, without calling the SDK, when the home dir cannot be created", async () => {
    const file = path.join(home, "a-file");
    writeFileSync(file, "");
    expect(await backendAt(path.join(file, "home")).runTurn(input())).toMatchObject({ ok: false, kind: "TRANSIENT" });
    expect(sdk.calls).toHaveLength(0);
  });

  it("logs extra usage, and a failure with its kind and latency only", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    sdk.stream = streamOf(init(), { type: "rate_limit_event", rate_limit_info: { status: "rejected", overageStatus: "allowed" }, session_id: "s", uuid: "u" }, result());
    expect(await backendAt(home).runTurn(input())).toMatchObject({ ok: true, extraUsage: true });
    expect(warn).toHaveBeenCalledWith({ latencyMs: expect.any(Number) }, "claude turn used extra usage");
    warn.mockClear();
    sdk.stream = streamOf(init(), result({ subtype: "error_during_execution", is_error: true, errors: ["socket hang up near Ghatkopar"] }));
    expect(await backendAt(home).runTurn(input())).toMatchObject({ ok: false, kind: "TRANSIENT" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith({ kind: "TRANSIENT", latencyMs: expect.any(Number) }, "claude turn failed");
  });

  it("warns when the worker runs as root", () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    vi.spyOn(process as Required<Pick<NodeJS.Process, "getuid">>, "getuid").mockReturnValue(0);
    backendAt(home);
    expect(warn).toHaveBeenCalledWith("worker runs as root; run the container as a non-root user");
  });
});
