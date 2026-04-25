/**
 * Append-only audit log helper. Every meaningful agent decision goes through
 * this — life-and-death software requires a complete trail for incident
 * investigations.
 *
 * Don't throw on log failures: an audit-write failure should not break the
 * primary flow, but should surface in server logs.
 */
import { supabase } from "./supabase";
import type { AgentActionType } from "./types";

interface AuditEntry {
  conversationId: string;
  messageId?: string | null;
  actionType: AgentActionType;
  toolName?: string | null;
  toolInput?: unknown;
  toolOutput?: unknown;
  messageText?: string | null;
  metadata?: Record<string, unknown> | null;
  actor?: string | null;
}

export async function audit(entry: AuditEntry): Promise<void> {
  try {
    const { error } = await supabase.from("agent_actions").insert({
      conversation_id: entry.conversationId,
      message_id: entry.messageId ?? null,
      action_type: entry.actionType,
      tool_name: entry.toolName ?? null,
      tool_input: entry.toolInput ?? null,
      tool_output: entry.toolOutput ?? null,
      message_text: entry.messageText ?? null,
      metadata: entry.metadata ?? null,
      actor: entry.actor ?? "agent",
    });
    if (error) console.warn("audit log insert failed:", error.message);
  } catch (e) {
    console.warn("audit log threw:", e);
  }
}
