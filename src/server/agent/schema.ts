import { z } from "zod";
import { INTENTS, LANGUAGES } from "../types";
import type { StructuredReply } from "./types";

const REPLY_MAX_CHARS = 1500;

export const REPLY_JSON_SCHEMA = {
  type: "object",
  properties: {
    // minLength/maxLength are mandated by spec §5.6, and they keep this schema off the CLI's strict-decoding path.
    reply: {
      type: "string",
      minLength: 1,
      maxLength: REPLY_MAX_CHARS,
      description: "The exact WhatsApp message to send, in the reporter's language. Phone numbers only as {{AMB:<handle>}}, {{CLINIC:<handle>}} or any {{PHONE:<key>}} token exactly as a tool returned it.",
    },
    language: { type: "string", enum: [...LANGUAGES] },
    intent: { type: "string", enum: [...INTENTS] },
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

/** Mirrors REPLY_JSON_SCHEMA: strict at both levels, the same enums, and string lengths in code points (zod 4 counts them as JSON Schema does). */
export const replySchema = z.strictObject({
  reply: z.string().min(1).max(REPLY_MAX_CHARS),
  language: z.enum(LANGUAGES),
  intent: z.enum(INTENTS),
  location: z.strictObject({ city: z.string().nullable(), area: z.string().nullable() }),
  needs_human: z.boolean(),
  notes: z.string().nullable(),
});

/** Like parseStructuredReply, but on failure says why: one "path: message" line per issue. */
export function parseStructuredReplyDetailed(u: unknown): { ok: true; data: StructuredReply } | { ok: false; issues: string[] } {
  const r = replySchema.safeParse(u);
  if (r.success) return { ok: true, data: r.data };
  return { ok: false, issues: r.error.issues.map((i) => `${i.path.length > 0 ? i.path.map(String).join(".") : "(root)"}: ${i.message}`) };
}

export function parseStructuredReply(u: unknown): StructuredReply | null {
  const r = parseStructuredReplyDetailed(u);
  return r.ok ? r.data : null;
}
