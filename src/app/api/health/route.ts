import { computeHealth } from "@/server/health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const h = await computeHealth();
  return Response.json(h, { status: h.status, headers: { "cache-control": "no-store" } });
}
