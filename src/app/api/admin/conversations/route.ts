import { isAdminRequest, unauthorized } from "@/server/admin/auth";
import { listConversations, type ConversationFilter } from "@/server/admin/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!isAdminRequest(request)) return unauthorized();
  const url = new URL(request.url);
  const filter = (["all", "flagged", "human", "test"].includes(url.searchParams.get("filter") ?? "") ? url.searchParams.get("filter") : "all") as ConversationFilter;
  const rows = await listConversations({ filter, search: url.searchParams.get("q") ?? undefined });
  return Response.json(rows);
}
