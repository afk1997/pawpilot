import { isAdminRequest, unauthorized } from "@/server/admin/auth";
import { listConversations, type ConversationFilter } from "@/server/admin/queries";
import { log, safeErrorFields } from "@/server/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!isAdminRequest(request)) return unauthorized();
  const url = new URL(request.url);
  const filter = (["all", "flagged", "human", "test"].includes(url.searchParams.get("filter") ?? "") ? url.searchParams.get("filter") : "all") as ConversationFilter;
  try {
    const rows = await listConversations({ filter, search: url.searchParams.get("q") ?? undefined });
    return Response.json(rows);
  } catch (e) {
    // A failed query's own text can quote its parameters, the searched phone among them: only its class and code are logged.
    log.error({ ...safeErrorFields(e) }, "admin conversations query failed");
    return Response.json({ error: "unavailable" }, { status: 503 });
  }
}
