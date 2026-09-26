import { checkPassword, cookieHeaderValue, loginLimiter, signAdminSession } from "@/server/admin/auth";
import { log } from "@/server/log";

export const runtime = "nodejs";
const THIRTY_DAYS_SEC = 30 * 24 * 60 * 60;
const MAX_BODY_BYTES = 4 * 1024;

function clientIp(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
}

/**
 * The body as text, or null when it is over MAX_BODY_BYTES: a declared oversized body is refused unread, and reading
 * stops at the first chunk past the cap. A body that fails mid-read comes back empty, which fails the password check.
 */
async function readCappedBody(request: Request): Promise<string | null> {
  if (Number(request.headers.get("content-length")) > MAX_BODY_BYTES) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BODY_BYTES) {
        void reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return "";
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * The `password` of a JSON object body; anything else (not JSON, not an object, not a string) is an empty password, which
 * is wrong. The parse error stays in here because it quotes its input, which is the password.
 */
function passwordFrom(body: string): string {
  try {
    const password = (JSON.parse(body) as { password?: unknown } | null)?.password;
    return typeof password === "string" ? password : "";
  } catch {
    return "";
  }
}

export async function POST(request: Request) {
  const ip = clientIp(request);
  const body = await readCappedBody(request);
  if (body === null) return Response.json({ error: "request too large" }, { status: 413 });
  // The body is read first so that nothing awaits between this check and recording the failure: concurrent attempts are
  // counted one at a time. The backstop goes first so a refused attempt from a new ip adds nothing to the per-ip map.
  if (!loginLimiter.allowGlobal() || !loginLimiter.allow(ip)) return Response.json({ error: "too many attempts, try later" }, { status: 429 });
  if (!checkPassword(passwordFrom(body))) {
    loginLimiter.recordFailure(ip);
    if (!loginLimiter.allowGlobal()) log.info({ ip }, "admin login locked out for every ip");
    else if (!loginLimiter.allow(ip)) log.info({ ip }, "admin login locked out");
    return Response.json({ error: "wrong password" }, { status: 401 });
  }
  loginLimiter.reset(ip);
  log.info({ ip }, "admin login");
  const token = signAdminSession(Date.now() + THIRTY_DAYS_SEC * 1000);
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json", "set-cookie": cookieHeaderValue(token, THIRTY_DAYS_SEC) },
  });
}

export async function DELETE() {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json", "set-cookie": cookieHeaderValue("", 0) },
  });
}
