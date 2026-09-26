import { describe, it, expect, beforeEach, vi } from "vitest";
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

  it("refuses the fake backend in production", () => {
    try {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("LLM_BACKEND", "fake");
      resetConfigForTests();
      expect(() => getConfig()).toThrow(/LLM_BACKEND/);
      vi.stubEnv("LLM_BACKEND", "claude-code");
      resetConfigForTests();
      expect(getConfig().llmBackend).toBe("claude-code");
    } finally {
      vi.unstubAllEnvs();
      resetConfigForTests();
    }
  });

  it("refuses webhook verification off, or an empty or blank webhook secret, in production", () => {
    try {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("LLM_BACKEND", "claude-code");
      vi.stubEnv("INTERAKT_WEBHOOK_SECRET", "s3cret");
      vi.stubEnv("INTERAKT_WEBHOOK_VERIFY_MODE", "off");
      resetConfigForTests();
      expect(() => getConfig()).toThrow(/INTERAKT_WEBHOOK_VERIFY_MODE: .*production/);
      vi.stubEnv("INTERAKT_WEBHOOK_VERIFY_MODE", "hmac");
      for (const secret of ["", " \t"]) {
        vi.stubEnv("INTERAKT_WEBHOOK_SECRET", secret);
        resetConfigForTests();
        expect(() => getConfig()).toThrow(/INTERAKT_WEBHOOK_SECRET: .*production/);
      }
      vi.stubEnv("INTERAKT_WEBHOOK_SECRET", "s3cret");
      resetConfigForTests();
      expect(getConfig().interakt).toMatchObject({ verifyMode: "hmac", webhookSecret: "s3cret" });
    } finally {
      vi.unstubAllEnvs();
      resetConfigForTests();
    }
  });

  it("allows webhook verification off and an empty secret outside production, for local sandbox testing", () => {
    try {
      vi.stubEnv("NODE_ENV", "development");
      vi.stubEnv("INTERAKT_WEBHOOK_SECRET", "");
      vi.stubEnv("INTERAKT_WEBHOOK_VERIFY_MODE", "off");
      resetConfigForTests();
      expect(getConfig().interakt).toMatchObject({ verifyMode: "off", webhookSecret: "" });
    } finally {
      vi.unstubAllEnvs();
      resetConfigForTests();
    }
  });

  it("trims the OAuth token, and reads one that is only whitespace as unset", () => {
    try {
      vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "  sk-ant-oat01-test\n");
      resetConfigForTests();
      expect(getConfig().claude.oauthToken).toBe("sk-ant-oat01-test");
      vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", " \t\n");
      resetConfigForTests();
      expect(getConfig().claude.oauthToken).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
      resetConfigForTests();
    }
  });

  it("caps the worker concurrency at 8", () => {
    const configured = process.env.WORKER_CONCURRENCY;
    try {
      process.env.WORKER_CONCURRENCY = "9";
      expect(() => getConfig()).toThrow(/WORKER_CONCURRENCY/);
      process.env.WORKER_CONCURRENCY = "8";
      resetConfigForTests();
      expect(getConfig().workerConcurrency).toBe(8);
    } finally {
      if (configured === undefined) delete process.env.WORKER_CONCURRENCY;
      else process.env.WORKER_CONCURRENCY = configured;
      resetConfigForTests();
    }
  });
});
