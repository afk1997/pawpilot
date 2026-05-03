/**
 * Tool-using LLM agent for the Arham Always Care WhatsApp dispatcher.
 *
 * Wires Vercel AI SDK v6 against the provider chosen by `AI_MODEL` (the
 * `provider/model` string is the routing key — see src/lib/ai-provider.ts).
 * Default `anthropic/claude-sonnet-4-6`.
 *
 * Hard properties:
 *  - LLM never types phone digits — phone numbers come from tool results,
 *    and the system prompt forbids the LLM from typing digits itself.
 *  - Step cap (default 5) — prevents runaway loops; if exceeded, return a
 *    safe fallback message and let the orchestrator escalate.
 *  - Audit every tool call — args + result captured to agent_actions.
 */
import { generateText, stepCountIs } from "ai";
import { ARHAM_SYSTEM_PROMPT } from "./system-prompt";
import { buildAgentTools } from "./tools";
import { audit } from "./audit";
import { resolveModel } from "./ai-provider";
import type { Language } from "./types";

const MAX_STEPS = Number(process.env.AI_MAX_STEPS ?? 5);
const MODEL_ID = process.env.AI_MODEL ?? "anthropic/claude-sonnet-4-6";

export interface AgentTurnInput {
  conversationId: string;
  reporterPhone: string;
  reporterName: string | null;
  history: { role: "user" | "assistant"; content: string }[];
  language: Language;
  conversationStatus: string;
  hasLocation: boolean;
}

export interface ToolCallRecord {
  name: string;
  input: unknown;
  output: unknown;
  /** True when the tool's execute threw or returned a typed error. */
  failed?: boolean;
}

export interface AgentTurnResult {
  /** Final text to send to the reporter. May be empty if the agent decided not to speak. */
  text: string;
  /** Whether the agent escalated this turn (so the orchestrator can skip sending if appropriate). */
  escalated: boolean;
  /** Whether we hit the step cap and used a fallback. */
  hitStepCap: boolean;
  /** Token usage for cost tracking. */
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
  /** All tool calls made this turn. */
  toolCalls: ToolCallRecord[];
  /** Set when generateText threw despite retries. "transient" → caller may
   *  prefer a softer fallback message; "exhausted" → escalate to dispatcher. */
  error?: "transient" | "exhausted";
}

export async function runAgentTurn(input: AgentTurnInput): Promise<AgentTurnResult> {
  const tools = buildAgentTools(input.conversationId);

  // Frame the conversation context so the LLM has structured awareness of
  // status, language, reporter — without us re-typing it inside the system prompt.
  const contextNote = [
    `Conversation context:`,
    `- Reporter phone: ${input.reporterPhone}`,
    `- Reporter name: ${input.reporterName ?? "unknown"}`,
    `- Detected language: ${input.language}`,
    `- Status: ${input.conversationStatus}`,
    `- Reporter has shared location yet: ${input.hasLocation ? "yes" : "no"}`,
  ].join("\n");

  let escalated = false;
  let hitStepCap = false;
  let text = "";
  let finishReason: string | undefined;
  let usage: AgentTurnResult["usage"];
  let errorState: AgentTurnResult["error"];
  const toolCalls: ToolCallRecord[] = [];

  const { model } = resolveModel(MODEL_ID);

  // Retry generateText up to 2 times on transient failures (rate limit,
  // 5xx, network). On exhaustion, return error="exhausted" so the
  // orchestrator can send the right fallback message.
  const MAX_ATTEMPTS = 2;
  let lastError: unknown = null;
  // Use a structural type — the model is parameterized by the tools record
  // which leaks generic types up the stack; we only need the few fields
  // (text, steps, usage, finishReason) that all generateText returns share.
  type GenerateTextLike = {
    text?: string;
    steps?: unknown[];
    usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
    finishReason?: string;
  };
  let result: GenerateTextLike | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      result = await generateText({
        model,
        system: `${ARHAM_SYSTEM_PROMPT}\n\n${contextNote}`,
        messages: input.history,
        tools,
        toolChoice: "auto",
        stopWhen: stepCountIs(MAX_STEPS),
      });
      lastError = null;
      break;
    } catch (e) {
      lastError = e;
      const msg = e instanceof Error ? e.message : String(e);
      const transient = /(rate limit|429|5\d\d|timeout|temporar|ECONNRESET|ETIMEDOUT|network)/i.test(msg);
      console.warn(
        `[agent] generateText attempt ${attempt}/${MAX_ATTEMPTS} failed${transient ? " (transient)" : ""}: ${msg}`
      );
      await audit({
        conversationId: input.conversationId,
        actionType: "degraded",
        metadata: {
          source: "ai_generate_text",
          attempt,
          transient,
          error: msg.slice(0, 500),
        },
      });
      if (!transient || attempt === MAX_ATTEMPTS) break;
      await new Promise((r) => setTimeout(r, 250 * attempt)); // simple linear backoff
    }
  }

  if (!result) {
    const msg = lastError instanceof Error ? lastError.message : String(lastError);
    const transient = /(rate limit|429|5\d\d|timeout|temporar|ECONNRESET|ETIMEDOUT|network)/i.test(msg);
    console.error("[agent] generateText exhausted retries:", msg);
    return {
      text: "",
      escalated: false,
      hitStepCap: false,
      toolCalls,
      error: transient ? "transient" : "exhausted",
    };
  }

  try {

    text = result.text ?? "";
    finishReason = (result as { finishReason?: string }).finishReason;

    usage = {
      promptTokens: result.usage?.inputTokens,
      completionTokens: result.usage?.outputTokens,
      totalTokens: result.usage?.totalTokens,
    };

    // Capture tool calls + results for the orchestrator AND audit log.
    if (result.steps && Array.isArray(result.steps)) {
      for (const step of result.steps) {
        const s = step as {
          toolCalls?: { toolName: string; input: unknown }[];
          toolResults?: { toolName: string; output?: unknown; error?: unknown; type?: string }[];
        };
        const stepToolCalls = s.toolCalls ?? [];
        const stepToolResults = s.toolResults ?? [];
        for (let i = 0; i < stepToolCalls.length; i++) {
          const call = stepToolCalls[i];
          const out = stepToolResults[i];
          if (call.toolName === "escalate_to_dispatcher") escalated = true;
          const isError =
            out !== undefined &&
            ((out.type && /error/i.test(out.type)) || out.error !== undefined);

          toolCalls.push({
            name: call.toolName,
            input: call.input,
            output: out?.output ?? null,
            failed: isError,
          });

          await audit({
            conversationId: input.conversationId,
            actionType: "tool_call",
            toolName: call.toolName,
            toolInput: call.input,
            toolOutput: out?.output ?? null,
            metadata: isError ? { error: out?.error ?? out?.type, failed: true } : null,
          });
          if (isError) {
            console.warn(
              `[agent] tool ${call.toolName} errored:`,
              JSON.stringify(out?.error ?? out?.type)
            );
          }
        }
      }
    }

    // If text is empty and the agent didn't escalate, it usually means the
    // orchestrator is about to deliver a deterministic card (single-row
    // ambulance match, donation/volunteer card, etc.). The orchestrator
    // will inject the card text. We do NOT fall back to a generic apology.
    //
    // The fallback path is reserved for: model error, step cap with no
    // resolving tool call, neither escalation nor a deterministic card
    // call. Those cases are detected by the orchestrator (no card-class
    // tool call AND no text).
    if (!text || text.trim().length === 0) {
      hitStepCap = finishReason === "tool-calls";
    }
  } catch (e) {
    console.error("[agent] post-generation processing failed:", e);
    await audit({
      conversationId: input.conversationId,
      actionType: "degraded",
      metadata: { source: "ai_post_processing", error: e instanceof Error ? e.message : String(e) },
    });
    errorState = "exhausted";
  }

  return { text, escalated, hitStepCap, usage, toolCalls, error: errorState };
}

/** Backwards compat — Phase 1 stub kept for old imports. Will be removed once webhook is fully wired. */
export async function getAIResponse(
  _messages: { role: "user" | "assistant"; content: string }[]
): Promise<string> {
  void _messages;
  return "[Phase 1 stub — use runAgentTurn instead]";
}
