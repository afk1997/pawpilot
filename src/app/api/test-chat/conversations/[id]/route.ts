import { isAdminRequest, unauthorized } from "@/server/admin/auth";
import { getConversationDetail } from "@/server/admin/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isAdminRequest(request)) return unauthorized();
  const { id } = await params;
  if (!UUID.test(id)) return Response.json({ error: "not found" }, { status: 404 });
  const detail = await getConversationDetail(id);
  if (!detail || !detail.conversation.isTest) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json(detail);
}
