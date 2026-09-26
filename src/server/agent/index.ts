import { getConfig } from "../config";
import { ClaudeCodeBackend } from "./claude-code-backend";
import { FakeBackend } from "./fake-backend";
import type { LLMBackend } from "./types";

let override: LLMBackend | null = null;
let cached: LLMBackend | null = null;

/** Overrides getBackend() until called with null. Every call also drops the cached backend, so the next getBackend() builds a fresh one from getConfig(). */
export function setBackendForTests(b: LLMBackend | null): void {
  override = b;
  cached = null;
}

export function getBackend(): LLMBackend {
  if (override) return override;
  if (cached) return cached;
  const cfg = getConfig();
  cached = cfg.llmBackend === "fake"
    ? new FakeBackend()
    : new ClaudeCodeBackend({ model: cfg.claude.model, effort: cfg.claude.effort, maxTurns: cfg.claude.maxTurns, oauthToken: cfg.claude.oauthToken, homeDir: cfg.claude.homeDir });
  return cached;
}
