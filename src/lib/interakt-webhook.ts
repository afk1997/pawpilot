/**
 * Parse an Interakt inbound webhook payload into our normalized
 * IncomingMessage shape. We isolate Interakt-specific shape here so the rest
 * of the app stays provider-agnostic.
 *
 * Interakt webhook payload reference:
 *   https://docs.interakt.shop/docs/integrating-the-webhook
 *
 * The exact fields differ by event type; this parser handles the common ones
 * we care about: incoming text/image/video/audio/document/location.
 *
 * Returns null for events we don't process (status updates, system events).
 */

import type { IncomingMessage, MessageType } from "./types";

interface InteraktInboundPayload {
  type?: string;
  event?: string;
  // Common fields:
  data?: {
    customer?: {
      phone_number?: string;
      country_code?: string;
      whatsapp_phone_number?: string;
      profile_name?: string;
      name?: string;
    };
    message?: {
      id?: string;
      from?: string;
      timestamp?: string | number;
      type?: string;
      text?: { body?: string } | string;
      image?: { id?: string; mime_type?: string; sha256?: string; caption?: string; link?: string; url?: string };
      video?: { id?: string; mime_type?: string; caption?: string; link?: string; url?: string };
      audio?: { id?: string; mime_type?: string; voice?: boolean; link?: string; url?: string };
      document?: { id?: string; filename?: string; mime_type?: string; caption?: string; link?: string; url?: string };
      location?: { latitude?: number; longitude?: number; name?: string; address?: string };
      sticker?: { id?: string; mime_type?: string; link?: string; url?: string };
      contacts?: unknown;
    };
    // Some Interakt accounts deliver messages flattened, without nested .data:
    customer_phone?: string;
    message_id?: string;
    body?: string;
  };
  // Newer webhook shape may put fields at top level:
  message_id?: string;
  customer_phone_number?: string;
  customer_country_code?: string;
  customer_name?: string;
  message_type?: string;
  message_text?: string;
  media_url?: string;
  media_caption?: string;
  location_latitude?: number;
  location_longitude?: number;
  timestamp?: string | number;
}

const INBOUND_EVENT_TYPES = new Set([
  "message_received",
  "incoming_message",
  "message",
  "inbound",
]);

const STATUS_EVENT_TYPES = new Set([
  "message_status",
  "message_delivered",
  "message_read",
  "message_failed",
  "message_sent",
]);

/**
 * Best-effort normalization. If Interakt's payload shape differs from what
 * we've coded, this will still extract whatever fields it can find.
 */
export function parseInteraktPayload(raw: unknown): IncomingMessage | null {
  if (typeof raw !== "object" || raw === null) return null;
  const p = raw as InteraktInboundPayload;

  const eventType = (p.type ?? p.event ?? "").toLowerCase();
  if (eventType && STATUS_EVENT_TYPES.has(eventType)) return null; // delivery callbacks handled elsewhere
  if (eventType && !INBOUND_EVENT_TYPES.has(eventType)) {
    // Unknown event — try to parse anyway; some Interakt accounts don't set type clearly.
  }

  // Try nested shape first (Interakt v1 most common).
  const data = p.data ?? {};
  const msg = data.message ?? {};
  const customer = data.customer ?? {};

  // Coalesce id from any of the spots Interakt has historically used.
  const providerMessageId =
    msg.id ?? data.message_id ?? p.message_id ?? null;
  if (!providerMessageId) return null;

  // Coalesce phone.
  let phone =
    customer.whatsapp_phone_number ??
    customer.phone_number ??
    msg.from ??
    data.customer_phone ??
    p.customer_phone_number ??
    null;
  if (!phone) return null;
  if (!phone.startsWith("+")) {
    const cc = customer.country_code ?? p.customer_country_code ?? "+91";
    const ccClean = cc.startsWith("+") ? cc : `+${cc}`;
    phone = `${ccClean}${phone.replace(/^\+?/, "").replace(/\D/g, "")}`;
  }

  const fromName = customer.profile_name ?? customer.name ?? p.customer_name ?? null;

  // Determine message type + text body + media URL + location.
  let type: MessageType = "text";
  let text = "";
  let mediaUrl: string | null = null;
  let locationLat: number | null = null;
  let locationLng: number | null = null;

  const interaktType = (msg.type ?? p.message_type ?? "text").toLowerCase();
  switch (interaktType) {
    case "text":
      type = "text";
      text =
        typeof msg.text === "string"
          ? msg.text
          : msg.text?.body ?? data.body ?? p.message_text ?? "";
      break;
    case "image":
      type = "image";
      text = msg.image?.caption ?? p.media_caption ?? "";
      mediaUrl = msg.image?.url ?? msg.image?.link ?? p.media_url ?? null;
      break;
    case "video":
      type = "video";
      text = msg.video?.caption ?? p.media_caption ?? "";
      mediaUrl = msg.video?.url ?? msg.video?.link ?? p.media_url ?? null;
      break;
    case "audio":
    case "voice":
      type = "audio";
      mediaUrl = msg.audio?.url ?? msg.audio?.link ?? p.media_url ?? null;
      break;
    case "document":
      type = "document";
      text = msg.document?.caption ?? msg.document?.filename ?? "";
      mediaUrl = msg.document?.url ?? msg.document?.link ?? p.media_url ?? null;
      break;
    case "location":
      type = "location";
      locationLat = msg.location?.latitude ?? p.location_latitude ?? null;
      locationLng = msg.location?.longitude ?? p.location_longitude ?? null;
      text = [msg.location?.name, msg.location?.address].filter(Boolean).join(", ");
      break;
    case "sticker":
      type = "sticker";
      mediaUrl = msg.sticker?.url ?? msg.sticker?.link ?? null;
      break;
    case "contacts":
    case "contact":
      type = "contact";
      text = "";
      break;
    default:
      type = "text";
      text = data.body ?? p.message_text ?? "";
  }

  // Timestamp.
  const ts = msg.timestamp ?? p.timestamp;
  let receivedAt: Date;
  if (typeof ts === "number") {
    receivedAt = new Date(ts > 1e12 ? ts : ts * 1000);
  } else if (typeof ts === "string" && ts) {
    const n = Number(ts);
    receivedAt = isFinite(n) && n > 0 ? new Date(n > 1e12 ? n : n * 1000) : new Date(ts);
  } else {
    receivedAt = new Date();
  }

  return {
    providerMessageId,
    fromPhone: phone,
    fromName,
    type,
    text,
    mediaUrl,
    locationLat,
    locationLng,
    receivedAt,
  };
}

/**
 * Verify Interakt webhook signature, if INTERAKT_WEBHOOK_SECRET is set.
 *
 * Implementation note: Interakt's signing scheme varies by account — some use
 * a static `Interakt-Verify-Token` header, others HMAC-SHA256 of the raw body.
 * The implementation below supports both; configure INTERAKT_WEBHOOK_VERIFY_MODE
 * to "static" or "hmac" (default static).
 */
export async function verifyInteraktSignature(
  rawBody: string,
  headers: Headers
): Promise<boolean> {
  const secret = process.env.INTERAKT_WEBHOOK_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      console.warn("INTERAKT_WEBHOOK_SECRET not set — accepting all webhooks (dev mode).");
    }
    return true; // dev / sandbox: allow.
  }

  const mode = (process.env.INTERAKT_WEBHOOK_VERIFY_MODE ?? "static").toLowerCase();

  if (mode === "static") {
    const provided = headers.get("interakt-verify-token") ?? headers.get("x-interakt-token");
    return provided === secret;
  }

  if (mode === "hmac") {
    const provided = headers.get("x-interakt-signature") ?? headers.get("x-hub-signature-256");
    if (!provided) return false;
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const sig = await crypto.subtle.sign("HMAC", key, enc.encode(rawBody));
    const hex =
      "sha256=" +
      Array.from(new Uint8Array(sig))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    return timingSafeEq(provided, hex);
  }

  return false;
}

function timingSafeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
