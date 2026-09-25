import { getConfig } from "@/server/config";
import { log, maskPhone } from "@/server/log";
import { parseInteraktPayload, verifyInteraktSignature } from "@/server/interakt/webhook";
import { recordEvent, storeReporterMessage, upsertConversationByPhone } from "@/server/inbound/store";
import { enqueueTurn } from "@/server/queue/boss";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 256 * 1024;
const seenUnknownTypes = new Set<string>();

export async function GET() {
  return new Response("ok", { status: 200 });
}

export async function POST(request: Request) {
  const cfg = getConfig();
  const rawBody = await request.text();
  if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) {
    return Response.json({ status: "too_large" }, { status: 413 });
  }
  if (cfg.logRawWebhooks) log.debug({ body: rawBody.slice(0, 4096) }, "raw webhook");

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
    return Response.json({ status: "bad_json" }, { status: 400 });
  }

  const parsed = parseInteraktPayload(payload);
  if (parsed.kind === "ignored") {
    log.info({ eventType: parsed.eventType, reason: parsed.reason }, "webhook ignored");
    return Response.json({ status: "ignored", reason: parsed.reason, event_type: parsed.eventType });
  }
  const m = parsed.message;

  const known = ["Text", "Image", "Video", "Audio", "Document", "Location", "Sticker", "InteractiveButtonReply", "InteractiveListReply"];
  if (!known.includes(m.rawContentType) && !seenUnknownTypes.has(m.rawContentType)) {
    seenUnknownTypes.add(m.rawContentType);
    await recordEvent("unknown_payload", { contentType: m.rawContentType, keys: Object.keys((payload as { data?: { message?: object } }).data?.message ?? {}) });
  }

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
  if (!stored.inserted) return Response.json({ status: "duplicate" });

  const jobId = await enqueueTurn(conversation.id);
  if (jobId === null) log.info({ conversationId: conversation.id }, "turn deduplicated");
  log.info({ conversationId: conversation.id, kind: m.kind, phone: maskPhone(m.fromPhone) }, "inbound queued");
  return Response.json({ status: "queued", conversationId: conversation.id, messageId: stored.id });
}
