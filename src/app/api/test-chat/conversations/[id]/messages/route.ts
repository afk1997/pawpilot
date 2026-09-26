import { eq } from "drizzle-orm";
import { isAdminRequest, unauthorized } from "@/server/admin/auth";
import { UUID_RE } from "@/server/admin/ids";
import { readAdminJsonPost } from "@/server/admin/json-post";
import { MAX_CONTENT_CHARS } from "@/server/admin/test-chat";
import { getDb } from "@/server/db/client";
import { conversations } from "@/server/db/schema";
import { storeReporterMessage } from "@/server/inbound/store";
import { log, safeErrorFields } from "@/server/log";
import { enqueueTurn } from "@/server/queue/boss";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Room for MAX_CONTENT_CHARS of Devanagari or Gujarati, 3 bytes each in UTF-8, where the default 4 KB fits about 1,360. */
const MAX_BODY_BYTES = 16 * 1024;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isAdminRequest(request)) return unauthorized();
  const { id } = await params;
  const body = await readAdminJsonPost(request, { maxBytes: MAX_BODY_BYTES });
  if (body instanceof Response) return body;
  const content = typeof body.content === "string" ? body.content.trim() : "";
  if (!content) return Response.json({ error: "content required" }, { status: 400 });
  if (content.length > MAX_CONTENT_CHARS) return Response.json({ error: `content over ${MAX_CONTENT_CHARS} characters` }, { status: 413 });
  if (!UUID_RE.test(id)) return Response.json({ error: "not found" }, { status: 404 });
  const [c] = await getDb().select().from(conversations).where(eq(conversations.id, id));
  if (!c || !c.isTest) return Response.json({ error: "not found" }, { status: 404 });
  const stored = await storeReporterMessage(c.id, { kind: "text", content });
  try {
    await getDb().update(conversations).set({ lastInboundAt: new Date(), updatedAt: new Date() }).where(eq(conversations.id, c.id));
    await enqueueTurn(c.id, { immediate: true });
  } catch (e) {
    // The message is stored, so the worker's sweep answers it within a minute or so. A failed query's own text can
    // quote its parameters, so only the error's class and code are logged.
    log.error({ ...safeErrorFields(e) }, "test chat message stored but its turn was not queued");
    return Response.json({ status: "stored", messageId: stored.id }, { status: 202 });
  }
  return Response.json({ status: "queued", messageId: stored.id }, { status: 202 });
}
