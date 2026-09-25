import { describe, it, expect, beforeEach } from "vitest";
import { getConfig, resetConfigForTests } from "@/server/config";

describe("getConfig", () => {
  beforeEach(() => resetConfigForTests());

  it("parses the test environment with defaults", () => {
    const c = getConfig();
    expect(c.databaseUrl).toContain("postgres://");
    expect(c.claude.model).toBe("claude-sonnet-5");
    expect(c.claude.effort).toBe("medium");
    expect(c.claude.maxTurns).toBe(6);
    expect(c.claude.turnTimeoutMs).toBe(45_000);
    expect(c.llmBackend).toBe("fake");
    expect(c.workerConcurrency).toBe(4);
    expect(c.helplinePhone).toBe("+919999900000");
  });

  it("rejects a helpline phone that is not E.164", () => {
    process.env.HELPLINE_PHONE = "99999";
    expect(() => getConfig()).toThrow(/HELPLINE_PHONE/);
    process.env.HELPLINE_PHONE = "+919999900000";
  });

  it("memoizes until reset", () => {
    const a = getConfig();
    process.env.LLM_EFFORT = "high";
    expect(getConfig()).toBe(a);
    resetConfigForTests();
    expect(getConfig().claude.effort).toBe("high");
    process.env.LLM_EFFORT = "medium";
  });
});
