import { randomInt } from "node:crypto";
import { isAdminRequest, unauthorized } from "@/server/admin/auth";
import { readAdminJsonPost } from "@/server/admin/json-post";
import { listConversations } from "@/server/admin/queries";
import { getDb } from "@/server/db/client";
import { conversations } from "@/server/db/schema";
import { log, safeErrorFields } from "@/server/log";
import { LANGUAGES, type Language } from "@/server/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** "+91TEST_" and 8 random lowercase letters: letters only, so it can never be read as a real number. */
function testPhone(): string {
  return `+91TEST_${Array.from({ length: 8 }, () => String.fromCharCode(97 + randomInt(26))).join("")}`;
}

/** A failed query's own text can quote its parameters, so only the error's class and code are logged. */
function unavailable(e: unknown, message: string): Response {
  log.error({ ...safeErrorFields(e) }, message);
  return Response.json({ error: "unavailable" }, { status: 503 });
}

export async function GET(request: Request) {
  if (!isAdminRequest(request)) return unauthorized();
  try {
    return Response.json(await listConversations({ filter: "test" }));
  } catch (e) {
    return unavailable(e, "test chat query failed");
  }
}

export async function POST(request: Request) {
  if (!isAdminRequest(request)) return unauthorized();
  const body = await readAdminJsonPost(request);
  if (body instanceof Response) return body;
  const language = (LANGUAGES as readonly unknown[]).includes(body.language) ? (body.language as Language) : null;
  try {
    const [row] = await getDb()
      .insert(conversations)
      .values({ phone: testPhone(), isTest: true, language, mode: "agent" })
      .returning();
    return Response.json(row, { status: 201 });
  } catch (e) {
    return unavailable(e, "test chat create failed");
  }
}
