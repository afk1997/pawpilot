import { getConfig, type AppConfig } from "../config";
import { ClaudeCodeBackend } from "./claude-code-backend";
import { FakeBackend } from "./fake-backend";
import type { LLMBackend } from "./types";

let override: LLMBackend | null = null;
let cached: { config: AppConfig; backend: LLMBackend } | null = null;

/** Overrides getBackend() until called with null. Every call also drops the cached backend. */
export function setBackendForTests(b: LLMBackend | null): void {
  override = b;
  cached = null;
}

/** The backend for the current config, built once per config object, so a config reset rebuilds it. */
export function getBackend(): LLMBackend {
  if (override) return override;
  const config = getConfig();
  if (cached?.config === config) return cached.backend;
  const { claude } = config;
  const backend = config.llmBackend === "fake"
    ? new FakeBackend()
    : new ClaudeCodeBackend({
        model: claude.model, effort: claude.effort, maxTurns: claude.maxTurns, oauthToken: claude.oauthToken, homeDir: claude.homeDir,
        allowExtraUsage: claude.allowExtraUsage,
      });
  cached = { config, backend };
  return backend;
}
