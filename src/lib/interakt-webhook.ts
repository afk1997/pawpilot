/**
 * Interakt webhook payload parser + signature verifier.
 *
 * Reference: https://www.interakt.shop/resource-center/interakts-webhooks/
 *
 * Interakt-specific contract:
 *   - Returns 200 within 3 seconds (stricter than Meta's 5s).
 *   - Authenticates via HMAC-SHA256 in the `Interakt-Signature` header,
 *     formatted as `sha256=<hex>`.
 *   - Inbound message events have `type === "message_received"`.
 *   - There is NO GET-handshake (no hub.challenge); webhooks are POST-only.
 *
 * Inbound payload shape (from docs, real bodies may add fields):
 *   {
 *     "version": "1.0",
 *     "timestamp": "ISO-8601",
 *     "type": "message_received",
 *     "data": {
 *       "customer": {
 *         "id": "...",
 *         "channel_phone_number": "917003705584",
 *         "traits": { ... }
 *       },
 *       "message": {
 *         "id": "...",
 *         "chat_message_type": "CustomerMessage",
 *         "message_status": "Sent",
 *         "received_at_utc": "...",
 *         "message_content_type": "Text" | "Image" | "Video" | "Audio" | "Document" | "Location",
 *         "message": "the text body (for text)"
 *       }
 *     }
 *   }
 *
 * Other event types we skip: message_api_sent / delivered / read / failed,
 * message_campaign_*, account_alerts, etc. (delivery callbacks may be
 * persisted to messages.delivery_status in a future patch.)
 */

import type { IncomingMessage, MessageType } from "./types";

interface InteraktPayload {
  version?: string;
  timestamp?: string;
  type?: string; // "message_received" | "message_api_sent" | etc.
  data?: {
    customer?: {
      id?: string;
      channel_phone_number?: string;
      country_code?: string;
      traits?: {
        name?: string;
        firstName?: string;
        lastName?: string;
        whatsappName?: string;
        [k: string]: unknown;
      };
    };
    message?: {
      id?: string;
      chat_message_type?: string;
      message_status?: string;
      received_at_utc?: string;
      message_content_type?: string;
      message?: string; // text body for Text type
      // Media fields are not fully documented; we look in several
      // likely places defensively. Real shape will be confirmed via
      // raw-body logging on the first real call.
      url?: string;
      media_url?: string;
      media_id?: string;
      caption?: string;
      latitude?: number;
      longitude?: number;
      location?: { latitude?: number; longitude?: number; name?: string; address?: string };
      [k: string]: unknown;
    };
  };
}

const INBOUND_MESSAGE_TYPE = "message_received";

/** Map Interakt's `message_content_type` to our internal MessageType. */
function mapContentType(contentType: string | undefined): MessageType {
  switch ((contentType ?? "").toLowerCase()) {
    case "text":
      return "text";
    case "image":
      return "image";
    case "video":
      return "video";
    case "audio":
    case "voice":
      return "audio";
    case "document":
    case "file":
      return "document";
    case "location":
      return "location";
    case "sticker":
      return "sticker";
    case "contact":
    case "contacts":
      return "contact";
    default:
      return "text";
  }
}

/** Normalize "917003705584" → "+917003705584". Defensive for already-E.164 input. */
function toE164(raw: string | undefined, countryCodeHint?: string): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[^\d+]/g, "");
  if (cleaned.startsWith("+")) return cleaned;
  if (cleaned.length >= 11 && cleaned.length <= 15) return `+${cleaned}`;
  if (cleaned.length === 10) {
    const cc = (countryCodeHint ?? "+91").replace(/[^\d+]/g, "");
    const ccPrefix = cc.startsWith("+") ? cc : `+${cc || "91"}`;
    return `${ccPrefix}${cleaned}`;
  }
  return cleaned ? `+${cleaned}` : null;
}

/**
 * Parse an Interakt webhook body into a normalized IncomingMessage.
 * Returns null for events we don't process (status callbacks, account events).
 */
export function parseInteraktPayload(raw: unknown): IncomingMessage | null {
  if (typeof raw !== "object" || raw === null) return null;
  const p = raw as InteraktPayload;

  // Skip non-incoming events.
  if (p.type !== INBOUND_MESSAGE_TYPE) return null;

  const customer = p.data?.customer;
  const message = p.data?.message;
  if (!customer || !message) return null;
  if (!message.id) return null;

  // Skip outbound echoes — only customer messages should reach the agent.
  if (message.chat_message_type && message.chat_message_type !== "CustomerMessage") {
    return null;
  }

  const fromPhone = toE164(customer.channel_phone_number, customer.country_code);
  if (!fromPhone) return null;

  const fromName =
    customer.traits?.whatsappName ??
    customer.traits?.firstName ??
    customer.traits?.name ??
    null;

  const type = mapContentType(message.message_content_type);

  // Coalesce text body across the variants we've seen.
  let text = "";
  if (type === "text") {
    text = message.message ?? "";
  } else if (type === "image" || type === "video" || type === "document") {
    text = message.caption ?? message.message ?? "";
  } else if (type === "location") {
    const locName = message.location?.name ?? "";
    const locAddr = message.location?.address ?? "";
    text = [locName, locAddr].filter(Boolean).join(", ");
  }

  // Coalesce media URL across plausible field names.
  let mediaUrl: string | null = null;
  if (type !== "text" && type !== "location") {
    mediaUrl = message.url ?? message.media_url ?? null;
  }

  // Location coordinates.
  const lat =
    message.location?.latitude ??
    (typeof message.latitude === "number" ? message.latitude : null);
  const lng =
    message.location?.longitude ??
    (typeof message.longitude === "number" ? message.longitude : null);

  // Timestamp.
  let receivedAt: Date;
  const tsStr = message.received_at_utc ?? p.timestamp;
  if (tsStr) {
    const d = new Date(tsStr);
    receivedAt = isNaN(d.getTime()) ? new Date() : d;
  } else {
    receivedAt = new Date();
  }

  return {
    providerMessageId: message.id,
    fromPhone,
    fromName,
    type,
    text,
    mediaUrl,
    locationLat: lat ?? null,
    locationLng: lng ?? null,
    receivedAt,
  };
}

/**
 * Verify an Interakt webhook signature. Defaults to HMAC-SHA256 — the
 * scheme Interakt actually uses per their docs.
 *
 * Header: `Interakt-Signature: sha256=<hex>`
 * Computed as: HMAC-SHA256(secret_key, raw_request_body)
 *
 * If INTERAKT_WEBHOOK_SECRET isn't set, we log a warning and accept
 * (dev/sandbox only). Production must set it.
 *
 * Mode override: INTERAKT_WEBHOOK_VERIFY_MODE = "hmac" (default) or "off".
 */
export async function verifyInteraktSignature(
  rawBody: string,
  headers: Headers
): Promise<boolean> {
  const secret = process.env.INTERAKT_WEBHOOK_SECRET;
  const mode = (process.env.INTERAKT_WEBHOOK_VERIFY_MODE ?? "hmac").toLowerCase();

  if (mode === "off") return true;

  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      console.warn(
        "[webhook] INTERAKT_WEBHOOK_SECRET not set; refusing webhook in production."
      );
      return false;
    }
    return true; // dev only
  }

  // Header lookup is case-insensitive on the Headers object, so "Interakt-Signature"
  // and "interakt-signature" both work.
  const provided =
    headers.get("interakt-signature") ??
    headers.get("x-interakt-signature") ??
    headers.get("x-hub-signature-256");

  if (!provided) {
    console.warn("[webhook] no Interakt-Signature header on inbound request");
    return false;
  }

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(rawBody));
  const expected =
    "sha256=" +
    Array.from(new Uint8Array(sig))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

  return timingSafeEq(provided, expected);
}

function timingSafeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
