import { createHmac, timingSafeEqual } from "node:crypto";
import type { MessageKind } from "../types";

export interface ParsedInbound {
  providerMessageId: string;
  fromPhone: string;
  fromName: string | null;
  kind: MessageKind;
  content: string;
  mediaUrl: string | null;
  lat: number | null;
  lng: number | null;
  placeHint: string | null;
  interactiveId: string | null;
  receivedAt: Date;
  rawContentType: string;
}

export type ParseOutcome =
  | { kind: "inbound"; message: ParsedInbound }
  | { kind: "ignored"; reason: string; eventType: string };

interface InteraktCustomer {
  channel_phone_number?: string;
  phone_number?: string;
  country_code?: string;
  traits?: Record<string, unknown>;
}

interface InteraktPayload {
  type?: string;
  timestamp?: string;
  data?: {
    customer?: InteraktCustomer;
    message?: Record<string, unknown>;
  };
}

const INBOUND_TYPES = [/^message[_\s]received$/i, /^messages[_\s]received$/i, /^message[_\s]received[_\s]from[_\s]customers?$/i];

const MIN_PHONE_DIGITS = 8;

function digitsOf(v: unknown): string {
  return typeof v === "string" ? v.replace(/\D/g, "") : "";
}

/**
 * The sender in E.164, from the first source with at least 8 digits: `country_code` + `phone_number` ("+91",
 * "9876543210"), then `channel_phone_number`. The latter is the WhatsApp id, country code included and no "+"
 * ("917003705584"), so it only gains the "+"; adding +91 by length would turn a foreign sender ("6581234567",
 * Singapore) into a wrong Indian number.
 */
function toE164(customer: InteraktCustomer): string | null {
  const countryCode = digitsOf(customer.country_code);
  const phoneNumber = digitsOf(customer.phone_number);
  const sources = [countryCode && phoneNumber ? countryCode + phoneNumber : "", digitsOf(customer.channel_phone_number)];
  const digits = sources.find((d) => d.length >= MIN_PHONE_DIGITS);
  return digits ? `+${digits}` : null;
}

function mapKind(contentType: string): MessageKind {
  switch (contentType.toLowerCase()) {
    case "text": return "text";
    case "image": return "image";
    case "video": return "video";
    case "audio": case "voice": return "audio";
    case "document": case "file": return "document";
    case "location": return "location";
    case "sticker": return "sticker";
    case "contact": case "contacts": return "contact";
    case "interactivebuttonreply": case "interactivelistreply": return "interactive";
    default: return "text";
  }
}

function parseJsonString(v: unknown): Record<string, unknown> | null {
  if (typeof v !== "string") return null;
  try {
    const o = JSON.parse(v);
    return o && typeof o === "object" ? (o as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function parseInteraktPayload(raw: unknown): ParseOutcome {
  if (typeof raw !== "object" || raw === null) return { kind: "ignored", reason: "non_object", eventType: "(none)" };
  const p = raw as InteraktPayload;
  const eventType = typeof p.type === "string" ? p.type : "(none)";
  if (!INBOUND_TYPES.some((re) => re.test(eventType.trim()))) return { kind: "ignored", reason: "event_type", eventType };

  const customer = p.data?.customer;
  const message = p.data?.message;
  if (!customer || !message || typeof message.id !== "string") return { kind: "ignored", reason: "missing_fields", eventType };
  if (typeof message.chat_message_type === "string" && message.chat_message_type !== "CustomerMessage") {
    return { kind: "ignored", reason: "not_customer_message", eventType };
  }
  const fromPhone = toE164(customer);
  if (!fromPhone) return { kind: "ignored", reason: "no_phone", eventType };

  const traits = customer.traits ?? {};
  const fromName = [traits.whatsappName, traits.firstName, traits.name].find((v): v is string => typeof v === "string" && v.length > 0) ?? null;

  const rawContentType = typeof message.message_content_type === "string" ? message.message_content_type : "Text";
  const kind = mapKind(rawContentType);
  const body = typeof message.message === "string" ? message.message : "";
  const mediaUrl = typeof message.media_url === "string" && message.media_url.length > 0 ? message.media_url : null;

  let content = "";
  let lat: number | null = null;
  let lng: number | null = null;
  let placeHint: string | null = null;
  let interactiveId: string | null = null;

  if (kind === "location") {
    const loc = parseJsonString(body) ?? (message.location as Record<string, unknown> | undefined) ?? {};
    lat = typeof loc.latitude === "number" ? loc.latitude : Number(loc.latitude) || null;
    lng = typeof loc.longitude === "number" ? loc.longitude : Number(loc.longitude) || null;
    const parts = [loc.name, loc.address].filter((v): v is string => typeof v === "string" && v.length > 0);
    placeHint = parts.length ? parts.join(", ") : null;
    content = placeHint ?? "";
  } else if (kind === "interactive") {
    const obj = parseJsonString(body) ?? {};
    const reply = (obj.list_reply ?? obj.button_reply ?? {}) as Record<string, unknown>;
    interactiveId = typeof reply.id === "string" ? reply.id : null;
    content = typeof reply.title === "string" ? reply.title : body;
  } else {
    content = body;
  }

  const tsStr = (message.received_at_utc as string | undefined) ?? p.timestamp;
  const parsedDate = tsStr ? new Date(tsStr) : new Date();

  return {
    kind: "inbound",
    message: {
      providerMessageId: message.id,
      fromPhone,
      fromName,
      kind,
      content,
      mediaUrl: kind === "text" ? null : mediaUrl,
      lat,
      lng,
      placeHint,
      interactiveId,
      receivedAt: isNaN(parsedDate.getTime()) ? new Date() : parsedDate,
      rawContentType,
    },
  };
}

/** `Interakt-Signature: sha256=<hex>` = HMAC-SHA256(secret, raw body bytes). */
export async function verifyInteraktSignature(
  rawBody: string,
  signatureHeader: string | null,
  opts: { secret: string; mode: "hmac" | "off" }
): Promise<boolean> {
  if (opts.mode === "off") return true;
  if (!opts.secret) return false;
  if (!signatureHeader) return false;
  const expected = "sha256=" + createHmac("sha256", opts.secret).update(rawBody, "utf8").digest("hex");
  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
