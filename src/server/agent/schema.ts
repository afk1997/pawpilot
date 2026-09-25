import { z } from "zod";
import type { StructuredReply } from "./types";

export const REPLY_JSON_SCHEMA = {
  type: "object",
  properties: {
    reply: { type: "string", minLength: 1, maxLength: 1500, description: "The exact WhatsApp message to send, in the reporter's language. Phone numbers only as {{AMB:handle}}, {{CLINIC:handle}} or {{PHONE:helpline}} tokens." },
    language: { type: "string", enum: ["en", "hi", "mr", "gu"] },
    intent: { type: "string", enum: ["ambulance", "clinic", "donate", "volunteer", "faq", "suggestion", "smalltalk", "other"] },
    location: {
      type: "object",
      properties: { city: { type: ["string", "null"] }, area: { type: ["string", "null"] } },
      required: ["city", "area"],
      additionalProperties: false,
    },
    needs_human: { type: "boolean", description: "True when a human should look at this conversation." },
    notes: { type: ["string", "null"], description: "One internal line for the admin page, never sent." },
  },
  required: ["reply", "language", "intent", "location", "needs_human", "notes"],
  additionalProperties: false,
} as const;

export const replySchema = z.object({
  reply: z.string().min(1).max(1500),
  language: z.enum(["en", "hi", "mr", "gu"]),
  intent: z.enum(["ambulance", "clinic", "donate", "volunteer", "faq", "suggestion", "smalltalk", "other"]),
  location: z.object({ city: z.string().nullable(), area: z.string().nullable() }),
  needs_human: z.boolean(),
  notes: z.string().nullable(),
});

export function parseStructuredReply(u: unknown): StructuredReply | null {
  const r = replySchema.safeParse(u);
  return r.success ? r.data : null;
}
