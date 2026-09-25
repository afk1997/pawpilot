import { getConfig } from "@/server/config";
import { log, maskPhone } from "@/server/log";
import { parseInteraktPayload, verifyInteraktSignature } from "@/server/interakt/webhook";
import { recordEvent, storeReporterMessage, upsertConversationByPhone } from "@/server/inbound/store";
import { enqueueTurn } from "@/server/queue/boss";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 256 * 1024;
const KNOWN_CONTENT_TYPES = ["Text", "Image", "Video", "Audio", "Document", "Location", "Sticker", "InteractiveButtonReply", "InteractiveListReply"];
/** Ignore reasons that drop a real reporter's message, which will never be answered; the rest are expected noise. */
const UNUSABLE_MESSAGE_REASONS = ["missing_fields", "no_phone"];
const seenUnknownTypes = new Set<string>();

export async function GET() {
  return new Response("ok", { status: 200 });
}

export async function POST(request: Request) {
  const cfg = getConfig();
  const lengthHeader = request.headers.get("content-length");
  const declared = lengthHeader === null ? null : Number(lengthHeader);
  // A declared oversized body is refused unread; a chunked one has no content-length and is measured after reading.
  if (declared !== null && declared > MAX_BODY_BYTES) {
    log.warn({ declared }, "webhook body too large");
    return Response.json({ status: "too_large" }, { status: 413 });
  }
  const rawBody = await request.text();
  const bytes = Buffer.byteLength(rawBody, "utf8");
  if (bytes > MAX_BODY_BYTES) {
    log.warn({ declared, bytes }, "webhook body too large");
    return Response.json({ status: "too_large" }, { status: 413 });
  }
  if (cfg.logRawWebhooks && !cfg.isProduction) log.debug({ body: rawBody.slice(0, 4096) }, "raw webhook");

  const sigHeader = request.headers.get("interakt-signature") ?? request.headers.get("x-interakt-signature");
  const verified = await verifyInteraktSignature(rawBody, sigHeader, { secret: cfg.interakt.webhookSecret, mode: cfg.interakt.verifyMode });
  if (!verified) {
    log.warn("webhook signature verification failed");
    return Response.json({ status: "forbidden" }, { status: 403 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    log.warn({ bytes }, "webhook body is not JSON");
    return Response.json({ status: "bad_json" }, { status: 400 });
  }

  const parsed = parseInteraktPayload(payload);
  if (parsed.kind === "ignored") {
    const fields = { eventType: parsed.eventType, reason: parsed.reason };
    if (UNUSABLE_MESSAGE_REASONS.includes(parsed.reason)) log.warn(fields, "webhook ignored");
    else log.info(fields, "webhook ignored");
    return Response.json({ status: "ignored", reason: parsed.reason, event_type: parsed.eventType });
  }
  const m = parsed.message;

  // A DrizzleQueryError carries the query's values (phone, name, text) in its message and params; if it escaped,
  // Next would print it to stderr unmasked. Failures are logged as a hand-picked summary and answered 500 so Interakt retries.
  try {
    const conversation = await upsertConversationByPhone({ phone: m.fromPhone, name: m.fromName });
    if (conversation.isTest) {
      log.error({ phone: maskPhone(m.fromPhone) }, "webhook phone collides with a test conversation");
      return Response.json({ status: "ignored_test_conv" });
    }

    const stored = await storeReporterMessage(conversation.id, {
      providerMessageId: m.providerMessageId,
      kind: m.kind,
      content: m.content,
      mediaUrl: m.mediaUrl,
      lat: m.lat,
      lng: m.lng,
      placeLabel: m.placeHint,
      interactiveId: m.interactiveId,
    });
    if (!stored.inserted) {
      log.info({ conversationId: conversation.id, providerMessageId: m.providerMessageId }, "webhook duplicate");
      return Response.json({ status: "duplicate" });
    }

    await recordUnknownContentType(m.rawContentType, payload, conversation.id);

    const jobId = await enqueueTurn(conversation.id);
    if (jobId === null) log.info({ conversationId: conversation.id }, "turn deduplicated");
    log.info({ conversationId: conversation.id, kind: m.kind, phone: maskPhone(m.fromPhone) }, "inbound queued");
    return Response.json({ status: "queued", conversationId: conversation.id, messageId: stored.id });
  } catch (err) {
    log.error({ phone: maskPhone(m.fromPhone), providerMessageId: m.providerMessageId, ...errorSummary(err) }, "webhook inbound failed");
    return Response.json({ status: "error" }, { status: 500 });
  }
}

/** Captures the shape of a content type we don't handle, once per type per process; never fails the inbound. */
async function recordUnknownContentType(contentType: string, payload: unknown, conversationId: string): Promise<void> {
  if (KNOWN_CONTENT_TYPES.includes(contentType) || seenUnknownTypes.has(contentType)) return;
  try {
    const keys = Object.keys((payload as { data?: { message?: object } }).data?.message ?? {});
    await recordEvent("unknown_payload", { contentType, keys }, conversationId);
    seenUnknownTypes.add(contentType);
  } catch (err) {
    log.warn({ contentType, ...errorSummary(err) }, "unknown_payload telemetry failed");
  }
}

/**
 * Only the error code and the driver's own message (`cause.message`). Never the error itself, its message or
 * params, or `cause.detail`: those can quote reporter data. Errors without a cause (pg-boss, sockets) give their own code.
 */
function errorSummary(err: unknown): { code?: string; pgMessage?: string } {
  const e = (err ?? {}) as { code?: unknown; cause?: { code?: unknown; message?: unknown } | null };
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  return { code: str(e.cause?.code) ?? str(e.code), pgMessage: str(e.cause?.message) };
}
