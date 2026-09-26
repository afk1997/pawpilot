import { randomInt } from "node:crypto";
import { isAdminRequest, unauthorized } from "@/server/admin/auth";
import { readAdminJsonPost } from "@/server/admin/json-post";
import { listConversations } from "@/server/admin/queries";
import { getDb } from "@/server/db/client";
import { conversations } from "@/server/db/schema";
import { LANGUAGES, type Language } from "@/server/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** "+91TEST_" and 8 random lowercase letters: letters only, so it can never be read as a real number. */
function testPhone(): string {
  return `+91TEST_${Array.from({ length: 8 }, () => String.fromCharCode(97 + randomInt(26))).join("")}`;
}

export async function GET(request: Request) {
  if (!isAdminRequest(request)) return unauthorized();
  return Response.json(await listConversations({ filter: "test" }));
}

export async function POST(request: Request) {
  if (!isAdminRequest(request)) return unauthorized();
  const body = await readAdminJsonPost(request);
  if (body instanceof Response) return body;
  const language = (LANGUAGES as readonly unknown[]).includes(body.language) ? (body.language as Language) : null;
  const [row] = await getDb()
    .insert(conversations)
    .values({ phone: testPhone(), isTest: true, language, mode: "agent" })
    .returning();
  return Response.json(row, { status: 201 });
}
