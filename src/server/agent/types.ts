import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { Intent, Language } from "../types";
import type { ToolContext } from "./tools";

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
  /** Only the fake backend uses this, to simulate tool calls in tests and evals. */
  toolContext?: ToolContext;
}

export type BackendErrorKind = "LIMITED" | "AUTH" | "TRANSIENT" | "INVALID_OUTPUT";

/**
 * One tool_use block the model emitted, as the SDK stream showed it; isError when its tool_result was an error.
 * Includes calls the SDK refused before they reached our tools, and the "StructuredOutput" call that carries the reply.
 */
export interface ObservedToolUse {
  name: string;
  isError: boolean;
}

export type TurnResult =
  | {
      ok: true;
      structured: StructuredReply;
      usage: Record<string, unknown> | null;
      latencyMs: number;
      sessionId: string | null;
      model: string | null;
      costUsd: number | null;
      /** Only the Claude Code backend fills this. */
      toolUses?: ObservedToolUse[];
      /** True when the plan's limit was reached and extra usage (overage) paid for this turn. */
      extraUsage?: boolean;
      /**
       * Present when a usage limit was reached on the way (extra usage paid but is not allowed, or a rejection the CLI
       * still answered): the reply is delivered, then Claude pauses until this time, or for the runner's default when
       * null (no reset time given).
       */
      pauseUntil?: Date | null;
    }
  | {
      ok: false;
      kind: BackendErrorKind;
      message: string;
      retryAfter: Date | null;
      latencyMs: number;
      sessionId: string | null;
      /** Only the Claude Code backend fills this. */
      toolUses?: ObservedToolUse[];
    };

export interface LLMBackend {
  readonly name: string;
  runTurn(input: TurnInput): Promise<TurnResult>;
}
