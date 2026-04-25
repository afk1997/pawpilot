/**
 * AI tool-using agent — Phase 2 will replace this stub with a Vercel AI SDK
 * tool loop (find_ambulance_by_area, get_nearest_ambulance, etc.).
 *
 * For Phase 1 the webhook route only sends an instant acknowledgment, so
 * nothing imports this yet. The stub exists to keep the file present and
 * type-checkable as we build out the agent.
 */
export async function getAIResponse(
  _messages: { role: "user" | "assistant"; content: string }[]
): Promise<string> {
  return "[Phase 1 stub] LLM not yet wired — instant ack already sent by the webhook.";
}
