import { isAdminRequest, unauthorized } from "@/server/admin/auth";
import { UUID_RE } from "@/server/admin/ids";
import { getConversationDetail } from "@/server/admin/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isAdminRequest(request)) return unauthorized();
  const { id } = await params;
  if (!UUID_RE.test(id)) return Response.json({ error: "not found" }, { status: 404 });
  const detail = await getConversationDetail(id);
  if (!detail || !detail.conversation.isTest) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json(detail);
}
