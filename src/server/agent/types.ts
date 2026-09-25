import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { Intent, Language } from "../types";

export interface StructuredReply {
  reply: string;
  language: Language;
  intent: Intent;
  location: { city: string | null; area: string | null };
  needs_human: boolean;
  notes: string | null;
}

export interface TurnInput {
  conversationId: string;
  systemPrompt: string;
  prompt: string;
  toolServer: McpSdkServerConfigWithInstance | null;
  allowedToolNames: string[];
  timeoutMs: number;
}

export type BackendErrorKind = "LIMITED" | "AUTH" | "TRANSIENT" | "INVALID_OUTPUT";

export type TurnResult =
  | {
      ok: true;
      structured: StructuredReply;
      usage: Record<string, unknown> | null;
      latencyMs: number;
      sessionId: string | null;
      model: string | null;
      costUsd: number | null;
    }
  | { ok: false; kind: BackendErrorKind; message: string; retryAfter: Date | null; latencyMs: number; sessionId: string | null };

export interface LLMBackend {
  readonly name: string;
  runTurn(input: TurnInput): Promise<TurnResult>;
}
