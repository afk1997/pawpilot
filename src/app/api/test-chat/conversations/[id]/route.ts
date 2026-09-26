import { isAdminRequest, unauthorized } from "@/server/admin/auth";
import { UUID_RE } from "@/server/admin/ids";
import { getConversationDetail } from "@/server/admin/queries";
import { log, safeErrorFields } from "@/server/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isAdminRequest(request)) return unauthorized();
  const { id } = await params;
  if (!UUID_RE.test(id)) return Response.json({ error: "not found" }, { status: 404 });
  try {
    const detail = await getConversationDetail(id);
    if (!detail || !detail.conversation.isTest) return Response.json({ error: "not found" }, { status: 404 });
    return Response.json(detail);
  } catch (e) {
    // A failed query's own text can quote its parameters, so only the error's class and code are logged.
    log.error({ ...safeErrorFields(e) }, "test chat query failed");
    return Response.json({ error: "unavailable" }, { status: 503 });
  }
}
