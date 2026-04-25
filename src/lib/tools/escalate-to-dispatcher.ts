/**
 * Tool: escalate_to_dispatcher
 *
 * Switches the conversation to human mode and red-badges it on the
 * dispatcher dashboard. Used in narrow cases:
 *   - reporter explicitly asked for a human
 *   - reporter said they couldn't reach the driver
 *   - the agent hit a logical dead end
 *
 * The conversation_id is injected by the orchestrator (the LLM doesn't see
 * it); the tool just needs the reason from the LLM's reasoning.
 */
import { z } from "zod";
import { tool } from "ai";
import { supabase } from "../supabase";
import { audit } from "../audit";

export const escalateToDispatcherParams = z.object({
  reason: z
    .string()
    .min(3)
    .describe(
      "Short reason for escalation: 'cannot_reach_driver', 'manual_human_request', 'dead_end', 'unsafe_request', etc."
    ),
});

export type EscalateInput = z.infer<typeof escalateToDispatcherParams>;

export async function escalateToDispatcher(
  conversationId: string,
  input: EscalateInput
): Promise<{ ok: true; reason: string }> {
  await supabase
    .from("conversations")
    .update({
      mode: "human",
      status: "escalated",
      escalation_reason: input.reason,
      updated_at: new Date().toISOString(),
    })
    .eq("id", conversationId);

  await audit({
    conversationId,
    actionType: "escalation",
    metadata: { reason: input.reason, source: "tool" },
  });

  return { ok: true, reason: input.reason };
}

export function buildEscalateTool(conversationId: string) {
  return tool({
    description:
      "Escalate this conversation to a human dispatcher. Use ONLY for: (1) reporter asks for a human/operator, (2) reporter says they couldn't reach the driver, or (3) you've hit a logical dead end. Do NOT escalate for severe-injury wording — that's normal in animal emergencies; your job is to deliver the number fast.",
    inputSchema: escalateToDispatcherParams,
    execute: async (input) => escalateToDispatcher(conversationId, input),
  });
}
