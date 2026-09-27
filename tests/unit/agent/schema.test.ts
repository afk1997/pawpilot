import { describe, it, expect } from "vitest";
import { parseStructuredReply, parseStructuredReplyDetailed, replySchema, REPLY_JSON_SCHEMA } from "@/server/agent/schema";

describe("structured reply schema", () => {
  const good = { reply: "Namaste", language: "hi", intent: "smalltalk", location: { city: null, area: null }, needs_human: false, notes: null };
  it("accepts a valid object", () => {
    expect(parseStructuredReply(good)).toEqual(good);
  });
  it("rejects missing fields, bad enums and empty replies", () => {
    expect(parseStructuredReply({ ...good, language: "fr" })).toBeNull();
    expect(parseStructuredReply({ ...good, reply: "" })).toBeNull();
    expect(parseStructuredReply({ ...good, location: undefined })).toBeNull();
    expect(parseStructuredReply("nope")).toBeNull();
  });
  it("exposes a JSON schema with additionalProperties false", () => {
    expect(REPLY_JSON_SCHEMA.additionalProperties).toBe(false);
    expect(REPLY_JSON_SCHEMA.required).toEqual(["reply", "language", "intent", "location", "needs_human", "notes"]);
  });
  it("keeps the JSON schema and the zod schema in lockstep", () => {
    expect(REPLY_JSON_SCHEMA.properties.language.enum).toEqual(replySchema.shape.language.options);
    expect(REPLY_JSON_SCHEMA.properties.intent.enum).toEqual(replySchema.shape.intent.options);
    expect(REPLY_JSON_SCHEMA.properties.location.required).toEqual(["city", "area"]);
    expect(REPLY_JSON_SCHEMA.properties.location.additionalProperties).toBe(false);
    expect(REPLY_JSON_SCHEMA.properties.reply).toMatchObject({ minLength: 1, maxLength: 1500 });
  });
  it("rejects extra keys at both levels and missing required fields", () => {
    expect(parseStructuredReply({ ...good, extra: "x" })).toBeNull();
    expect(parseStructuredReply({ ...good, location: { city: null, area: null, extra: "x" } })).toBeNull();
    const noNotes: Record<string, unknown> = { ...good };
    delete noNotes.notes;
    expect(parseStructuredReply(noNotes)).toBeNull();
    expect(parseStructuredReply({ ...good, location: { area: null } })).toBeNull();
  });
  it("counts reply length in code points, as JSON Schema does", () => {
    expect(parseStructuredReply({ ...good, reply: "🐕".repeat(1500) })?.reply).toBe("🐕".repeat(1500));
    expect(parseStructuredReply({ ...good, reply: "🐕".repeat(1501) })).toBeNull();
  });
  it("reports why a reply was rejected as path: message lines", () => {
    expect(parseStructuredReplyDetailed(good)).toEqual({ ok: true, data: good });
    expect(parseStructuredReplyDetailed({ ...good, language: "fr", location: { city: null } })).toEqual({
      ok: false,
      issues: [expect.stringMatching(/^language: ./), expect.stringMatching(/^location\.area: ./)],
    });
    expect(parseStructuredReplyDetailed("nope")).toEqual({ ok: false, issues: [expect.stringMatching(/^\(root\): ./)] });
  });
  it("lets the model write any PHONE token a tool returned", () => {
    expect(REPLY_JSON_SCHEMA.properties.reply.description).toContain("{{PHONE:<key>}}");
  });
});
