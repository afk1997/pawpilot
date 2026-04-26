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

export interface AgentTurnResult {
  /** Final text to send to the reporter. May be empty if the agent decided not to speak. */
  text: string;
  /** Whether the agent escalated this turn (so the orchestrator can skip sending if appropriate). */
  escalated: boolean;
  /** Whether we hit the step cap and used a fallback. */
  hitStepCap: boolean;
  /** Token usage for cost tracking. */
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
}

const FALLBACK_BY_LANG: Record<Language, string> = {
  en: "I'm having trouble right now. A team member will be with you shortly.",
  hi: "मुझे अभी कुछ समस्या आ रही है। हमारी टीम का कोई सदस्य जल्द ही आपसे संपर्क करेगा।",
  mr: "मला आत्ता थोडी अडचण येत आहे. आमच्या टीममधील कोणीतरी लवकरच तुमच्याशी संपर्क करेल.",
  gu: "મને હાલ થોડી તકલીફ થઈ રહી છે. અમારી ટીમનો કોઈ સભ્ય ટૂંક સમયમાં તમારો સંપર્ક કરશે.",
};

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

  const { model } = resolveModel(MODEL_ID);

  try {
    const result = await generateText({
      model,
      system: `${ARHAM_SYSTEM_PROMPT}\n\n${contextNote}`,
      messages: input.history,
      tools,
      // Force the model to actually invoke tools when it has the info to.
      // Some providers (notably DeepSeek via openai-compatible) need this
      // explicit hint or they ignore the tool list.
      toolChoice: "auto",
      stopWhen: stepCountIs(MAX_STEPS),
    });

    text = result.text ?? "";
    finishReason = (result as { finishReason?: string }).finishReason;

    usage = {
      promptTokens: result.usage?.inputTokens,
      completionTokens: result.usage?.outputTokens,
      totalTokens: result.usage?.totalTokens,
    };

    // Audit each step's tool calls AND any tool errors. Tool errors must
    // be captured for incident investigations — silent failures are the
    // worst-case audit gap on life-and-death systems.
    if (result.steps && Array.isArray(result.steps)) {
      for (const step of result.steps) {
        const s = step as {
          toolCalls?: { toolName: string; input: unknown }[];
          toolResults?: { toolName: string; output?: unknown; error?: unknown; type?: string }[];
        };
        const toolCalls = s.toolCalls ?? [];
        const toolResults = s.toolResults ?? [];
        for (let i = 0; i < toolCalls.length; i++) {
          const call = toolCalls[i];
          const out = toolResults[i];
          if (call.toolName === "escalate_to_dispatcher") escalated = true;
          const isError =
            out !== undefined &&
            ((out.type && /error/i.test(out.type)) || out.error !== undefined);
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

    // Distinguish three end states:
    //   1. text empty + escalated → legitimate; orchestrator handles ack
    //      separately, do NOT send a fallback (would confuse reporter).
    //   2. text empty + finishReason "tool-calls" + steps == cap → ran
    //      out of steps; fall back gracefully.
    //   3. text empty + finishReason "stop" → degraded; surface fallback.
    if (!text || text.trim().length === 0) {
      if (escalated) {
        // Leave text empty — caller skips send.
      } else {
        hitStepCap = finishReason === "tool-calls";
        text = FALLBACK_BY_LANG[input.language] ?? FALLBACK_BY_LANG.en;
      }
    }
  } catch (e) {
    console.error("runAgentTurn failed:", e);
    await audit({
      conversationId: input.conversationId,
      actionType: "degraded",
      metadata: { source: "ai_generate_text", error: e instanceof Error ? e.message : String(e) },
    });
    text = FALLBACK_BY_LANG[input.language] ?? FALLBACK_BY_LANG.en;
  }

  return { text, escalated, hitStepCap, usage };
}

/** Backwards compat — Phase 1 stub kept for old imports. Will be removed once webhook is fully wired. */
export async function getAIResponse(
  _messages: { role: "user" | "assistant"; content: string }[]
): Promise<string> {
  return "[Phase 1 stub — use runAgentTurn instead]";
}
