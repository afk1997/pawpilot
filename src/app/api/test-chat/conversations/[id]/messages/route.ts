import { eq } from "drizzle-orm";
import { isAdminRequest, unauthorized } from "@/server/admin/auth";
import { readAdminJsonPost } from "@/server/admin/json-post";
import { getDb } from "@/server/db/client";
import { conversations } from "@/server/db/schema";
import { storeReporterMessage } from "@/server/inbound/store";
import { enqueueTurn } from "@/server/queue/boss";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The longest reporter message, once trimmed, that a test chat accepts. */
const MAX_CONTENT_CHARS = 2000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isAdminRequest(request)) return unauthorized();
  const { id } = await params;
  const body = await readAdminJsonPost(request);
  if (body instanceof Response) return body;
  const content = typeof body.content === "string" ? body.content.trim() : "";
  if (!content) return Response.json({ error: "content required" }, { status: 400 });
  if (content.length > MAX_CONTENT_CHARS) return Response.json({ error: `content over ${MAX_CONTENT_CHARS} characters` }, { status: 413 });
  if (!UUID.test(id)) return Response.json({ error: "not found" }, { status: 404 });
  const [c] = await getDb().select().from(conversations).where(eq(conversations.id, id));
  if (!c || !c.isTest) return Response.json({ error: "not found" }, { status: 404 });
  const stored = await storeReporterMessage(c.id, { kind: "text", content });
  await getDb().update(conversations).set({ lastInboundAt: new Date(), updatedAt: new Date() }).where(eq(conversations.id, c.id));
  await enqueueTurn(c.id, { immediate: true });
  return Response.json({ status: "queued", messageId: stored.id }, { status: 202 });
}
