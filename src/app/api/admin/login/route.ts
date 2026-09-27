import { checkPassword, cookieHeaderValue, LOGIN_RETRY_AFTER_SEC, loginLimiter, signAdminSession } from "@/server/admin/auth";
import { readAdminJsonPost } from "@/server/admin/json-post";
import { log } from "@/server/log";

export const runtime = "nodejs";
const THIRTY_DAYS_SEC = 30 * 24 * 60 * 60;

function clientIp(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
}

export async function POST(request: Request) {
  const ip = clientIp(request);
  // The refusals (403, 415, 413) come before the limit check: they are not guesses at the password, so they do not count.
  // A body that cannot be read or is not a JSON object is no password at all: a wrong one, counted below.
  const body = await readAdminJsonPost(request, { unusableBodyAsEmpty: true });
  if (body instanceof Response) return body;
  // The body is read first so that nothing awaits between this check and recording the failure: concurrent attempts are
  // counted one at a time.
  if (!loginLimiter.allowGlobal() || !loginLimiter.allow(ip)) {
    return Response.json({ error: "too many attempts, try later" }, { status: 429, headers: { "retry-after": String(LOGIN_RETRY_AFTER_SEC) } });
  }
  if (!checkPassword(typeof body.password === "string" ? body.password : "")) {
    loginLimiter.recordFailure(ip);
    if (!loginLimiter.allowGlobal()) log.warn({ ip }, "admin login locked out for every ip");
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
