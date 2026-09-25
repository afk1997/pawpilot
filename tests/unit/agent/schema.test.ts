import { describe, it, expect } from "vitest";
import { parseStructuredReply, REPLY_JSON_SCHEMA } from "@/server/agent/schema";

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
});
