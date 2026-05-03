import { supabase } from "../supabase";
import type { AnswerEngineTurnResult } from "./run-answer-engine";

export async function logAnswerEvent(input: {
  conversationId: string;
  inboundMessageId: string | null;
  outboundMessageId: string | null;
  result: AnswerEngineTurnResult;
  deliveryStatus?: string | null;
}): Promise<void> {
  try {
    const { error } = await supabase.from("answer_events").insert({
      conversation_id: input.conversationId,
      inbound_message_id: input.inboundMessageId,
      outbound_message_id: input.outboundMessageId,
      intent: input.result.intent,
      language: input.result.language,
      confidence: input.result.confidence,
      evidence: summarizeEvidence(input.result.evidence),
      validation: input.result.validation,
      answer_text: input.result.text,
      delivery_status: input.deliveryStatus ?? null,
      metadata: input.result.metadata ?? {},
    });
    if (error) console.warn("answer_events insert failed:", error.message);
  } catch (error) {
    console.warn("answer_events insert threw:", error);
  }
}

function summarizeEvidence(evidence: AnswerEngineTurnResult["evidence"]): Record<string, unknown> {
  return {
    intent: evidence.intent,
    confidence: evidence.confidence,
    factKeys: evidence.deterministicFacts.map((fact) => fact.key),
    linkKeys: evidence.officialLinks.map((link) => link.key),
    articleKeys: evidence.articles.map((article) => article.key),
    templateKeys: evidence.templates.map((template) => template.key),
    allowedPhoneCount: evidence.validationContext.allowedPhoneNumbers.length,
    allowedUrlCount: evidence.validationContext.allowedUrls.length,
    forbiddenClaims: evidence.forbiddenClaims,
  };
}
