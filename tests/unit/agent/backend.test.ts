import { describe, it, expect, afterEach, vi } from "vitest";
import { existsSync } from "node:fs";
import { getBackend, setBackendForTests } from "@/server/agent";
import { ClaudeCodeBackend } from "@/server/agent/claude-code-backend";
import { resetConfigForTests } from "@/server/config";
import { FakeBackend, errorResult, okReply } from "@/server/agent/fake-backend";
import type { TurnInput } from "@/server/agent/types";

const input = (prompt = ""): TurnInput => ({
  conversationId: "c1", systemPrompt: "", prompt, toolServer: null, allowedToolNames: [], timeoutMs: 1000,
});

describe("FakeBackend", () => {
  it("consumes its script in order and repeats the last step", async () => {
    const backend = new FakeBackend([okReply({ reply: "one" }), errorResult("TRANSIENT"), (i) => okReply({ reply: `three for ${i.conversationId}` })]);
    const outcomes: string[] = [];
    for (let n = 0; n < 4; n++) {
      const r = await backend.runTurn(input());
      outcomes.push(r.ok ? r.structured.reply : r.kind);
    }
    expect(outcomes).toEqual(["one", "TRANSIENT", "three for c1", "three for c1"]);
    expect(backend.calls).toHaveLength(4);
  });
  it("answers the last transcript line when it has no script", async () => {
    const r = await new FakeBackend().runTurn(input("CONTEXT\n[10:01] Reporter: hello\n[10:02] Reporter: dog is hurt\nWrite the next assistant reply now."));
    expect(r.ok && r.structured.reply).toBe("Fake backend reply to: [10:02] Reporter: dog is hurt");
  });
});

describe("getBackend", () => {
  afterEach(() => {
    setBackendForTests(null);
    vi.unstubAllEnvs();
    resetConfigForTests();
  });
  it("builds the configured backend once and reuses it", () => {
    const backend = getBackend();
    // tests/setup.ts sets LLM_BACKEND=fake
    expect(backend).toBeInstanceOf(FakeBackend);
    expect(getBackend()).toBe(backend);
  });
  it("prefers the test override, and null drops both the override and the cached backend", () => {
    const cached = getBackend();
    const override = new FakeBackend();
    setBackendForTests(override);
    expect(getBackend()).toBe(override);
    setBackendForTests(null);
    const rebuilt = getBackend();
    expect(rebuilt).not.toBe(override);
    expect(rebuilt).not.toBe(cached);
  });
  it("rebuilds the backend when getConfig() returns a different config", () => {
    const first = getBackend();
    resetConfigForTests();
    const second = getBackend();
    expect(second).not.toBe(first);
    expect(getBackend()).toBe(second);
  });
  it("builds the Claude backend without touching the disk, so a home dir it cannot create never fails getBackend()", () => {
    vi.stubEnv("LLM_BACKEND", "claude-code");
    vi.stubEnv("LLM_HOME_DIR", "/dev/null/arham-claude-home");
    resetConfigForTests();
    expect(getBackend()).toBeInstanceOf(ClaudeCodeBackend);
    expect(existsSync("/dev/null/arham-claude-home")).toBe(false);
  });
});
