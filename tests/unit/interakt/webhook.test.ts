import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { parseInteraktPayload, verifyInteraktSignature } from "@/server/interakt/webhook";

const base = (message: Record<string, unknown>, customer: Record<string, unknown> = {}) => ({
  version: "1.0",
  timestamp: "2026-09-25T10:00:00Z",
  type: "message_received",
  data: {
    customer: { id: "c1", channel_phone_number: "917003705584", traits: { name: "Asha" }, ...customer },
    message: { id: "m-1", chat_message_type: "CustomerMessage", received_at_utc: "2026-09-25T10:00:00Z", ...message },
  },
});

const senderPhone = (customer: Record<string, unknown>) => {
  const r = parseInteraktPayload(base({ message_content_type: "Text", message: "hi" }, customer));
  return r.kind === "inbound" ? r.message.fromPhone : null;
};

describe("parseInteraktPayload", () => {
  it("parses text", () => {
    const r = parseInteraktPayload(base({ message_content_type: "Text", message: "dog injured" }));
    expect(r.kind).toBe("inbound");
    if (r.kind !== "inbound") return;
    expect(r.message).toMatchObject({ providerMessageId: "m-1", fromPhone: "+917003705584", fromName: "Asha", kind: "text", content: "dog injured", mediaUrl: null });
  });
  it("parses image with caption and media url", () => {
    const r = parseInteraktPayload(base({ message_content_type: "Image", message: "see this", media_url: "https://x/y.jpg" }));
    expect(r.kind === "inbound" && r.message).toMatchObject({ kind: "image", content: "see this", mediaUrl: "https://x/y.jpg" });
  });
  it("parses audio as kind audio with empty content", () => {
    const r = parseInteraktPayload(base({ message_content_type: "Audio", message: "", media_url: "https://x/a.ogg" }));
    expect(r.kind === "inbound" && r.message).toMatchObject({ kind: "audio", content: "", mediaUrl: "https://x/a.ogg" });
  });
  it("parses a location JSON string", () => {
    const r = parseInteraktPayload(base({ message_content_type: "Location", message: JSON.stringify({ latitude: 18.5074, longitude: 73.8077, name: "Karve Nagar" }) }));
    expect(r.kind === "inbound" && r.message).toMatchObject({ kind: "location", lat: 18.5074, lng: 73.8077, placeHint: "Karve Nagar" });
  });
  it("parses list and button replies", () => {
    const list = parseInteraktPayload(base({ message_content_type: "InteractiveListReply", message: JSON.stringify({ type: "list_reply", list_reply: { id: "menu:ambulance", title: "Animal ambulance" } }) }));
    expect(list.kind === "inbound" && list.message).toMatchObject({ kind: "interactive", interactiveId: "menu:ambulance", content: "Animal ambulance" });
    const btn = parseInteraktPayload(base({ message_content_type: "InteractiveButtonReply", message: JSON.stringify({ type: "button_reply", button_reply: { id: "yes", title: "Yes" } }) }));
    expect(btn.kind === "inbound" && btn.message).toMatchObject({ kind: "interactive", interactiveId: "yes", content: "Yes" });
  });
  it("ignores our own outbound echoes", () => {
    const r = parseInteraktPayload(base({ message_content_type: "Text", message: "hi", chat_message_type: "PublicApiMessage" }));
    expect(r).toEqual({ kind: "ignored", reason: "not_customer_message", eventType: "message_received" });
  });
  it("ignores status events and the webhook test ping", () => {
    expect(parseInteraktPayload({ type: "message_api_delivered", data: {} }).kind).toBe("ignored");
    expect(parseInteraktPayload({ type: "Webhook Test", data: { customer: {}, message: {} } }).kind).toBe("ignored");
    expect(parseInteraktPayload(null).kind).toBe("ignored");
  });
  it("keeps unknown content types as text and records the raw type", () => {
    const r = parseInteraktPayload(base({ message_content_type: "Contacts", message: "" }));
    expect(r.kind === "inbound" && r.message).toMatchObject({ kind: "contact", rawContentType: "Contacts" });
    const unknown = parseInteraktPayload(base({ message_content_type: "Reaction", message: "👍" }));
    expect(unknown.kind === "inbound" && unknown.message).toMatchObject({ kind: "text", content: "👍", rawContentType: "Reaction" });
  });
  it("ignores a non-string event type instead of throwing", () => {
    expect(parseInteraktPayload({ type: 42, data: {} })).toEqual({ kind: "ignored", reason: "event_type", eventType: "(none)" });
  });
  it("takes the sender phone from country_code + phone_number, else from channel_phone_number without adding +91", () => {
    expect(senderPhone({})).toBe("+917003705584");
    expect(senderPhone({ channel_phone_number: "6581234567" })).toBe("+6581234567");
    expect(senderPhone({ country_code: "+91", phone_number: "9876543210", channel_phone_number: "919876543210" })).toBe("+919876543210");
    expect(senderPhone({ country_code: "91", phone_number: "9876543210", channel_phone_number: undefined })).toBe("+919876543210");
    // Both present and disagreeing with base()'s channel_phone_number: country_code + phone_number wins.
    expect(senderPhone({ country_code: "+91", phone_number: "9876543210" })).toBe("+919876543210");
  });
  it("never prepends the country code to a phone_number that already carries it", () => {
    expect(senderPhone({ country_code: "+91", phone_number: "919876543210" })).toBe("+919876543210");
    expect(senderPhone({ country_code: "91", phone_number: "+91 98765 43210" })).toBe("+919876543210");
    // Ten digits is a national number, even one that starts with 91: the code is prepended.
    expect(senderPhone({ country_code: "+91", phone_number: "9198765432" })).toBe("+919198765432");
  });
  it("ignores a message whose id is empty or blank, so it cannot shadow every later one as a duplicate", () => {
    for (const id of ["", "  "]) {
      expect(parseInteraktPayload(base({ id, message_content_type: "Text", message: "hi" }))).toEqual({
        kind: "ignored", reason: "missing_fields", eventType: "message_received",
      });
    }
  });
  it("reads the received time only from a string that parses, else leaves it to the stored row's default", () => {
    const at = (message: Record<string, unknown>, timestamp?: unknown) => {
      const r = parseInteraktPayload({ ...base({ message_content_type: "Text", message: "hi", ...message }), timestamp });
      return r.kind === "inbound" ? r.message.receivedAt : "ignored";
    };
    expect(at({}, "2026-09-25T09:00:00Z")).toEqual(new Date("2026-09-25T10:00:00Z"));
    for (const bad of [{ $date: 1 }, ["2026-09-25"], 1790000000, "not a date", null]) {
      expect(at({ received_at_utc: bad }, "2026-09-25T09:00:00Z")).toEqual(new Date("2026-09-25T09:00:00Z"));
      expect(at({ received_at_utc: bad })).toBeNull();
      expect(at({ received_at_utc: bad }, { $date: 1 })).toBeNull();
    }
  });
  it("ignores the message only when neither phone source has at least 8 digits", () => {
    expect(senderPhone({ country_code: "+91", phone_number: "98765" })).toBe("+917003705584");
    expect(senderPhone({ channel_phone_number: "70037055" })).toBe("+70037055");
    const r = parseInteraktPayload(base({ message_content_type: "Text", message: "hi" }, { country_code: "+91", phone_number: "98765", channel_phone_number: "7003705" }));
    expect(r).toEqual({ kind: "ignored", reason: "no_phone", eventType: "message_received" });
  });
});

describe("verifyInteraktSignature", () => {
  const secret = "s3cret";
  const body = '{"a":1}';
  const sig = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  it("accepts a valid signature and rejects a wrong or missing one", async () => {
    expect(await verifyInteraktSignature(body, sig, { secret, mode: "hmac" })).toBe(true);
    expect(await verifyInteraktSignature(body, "sha256=deadbeef", { secret, mode: "hmac" })).toBe(false);
    expect(await verifyInteraktSignature(body, null, { secret, mode: "hmac" })).toBe(false);
  });
  it("reads the hex in either case, and refuses a wrong signature of the right length", async () => {
    expect(await verifyInteraktSignature(body, sig.toUpperCase(), { secret, mode: "hmac" })).toBe(true);
    expect(await verifyInteraktSignature(body, `sha256=${sig.slice(7).toUpperCase()}`, { secret, mode: "hmac" })).toBe(true);
    const sameLength = "sha256=" + createHmac("sha256", "other-secret").update(body).digest("hex");
    expect(sameLength.length).toBe(sig.length);
    expect(await verifyInteraktSignature(body, sameLength, { secret, mode: "hmac" })).toBe(false);
  });
  it("accepts anything when mode is off", async () => {
    expect(await verifyInteraktSignature(body, null, { secret, mode: "off" })).toBe(true);
  });
  it("rejects when hmac mode has no secret", async () => {
    expect(await verifyInteraktSignature(body, sig, { secret: "", mode: "hmac" })).toBe(false);
  });
});
