import { checkPassword, cookieHeaderValue, LOGIN_RETRY_AFTER_SEC, loginLimiter, signAdminSession } from "@/server/admin/auth";
import { log } from "@/server/log";

export const runtime = "nodejs";
const THIRTY_DAYS_SEC = 30 * 24 * 60 * 60;
const MAX_BODY_BYTES = 4 * 1024;
/**
 * What a browser sends for a request from our own page or a typed address. Any other value means another page made it,
 * "same-site" included: a sibling subdomain is not this admin page.
 */
const ALLOWED_FETCH_SITES = ["same-origin", "none"];

function clientIp(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
}

/** A browser names the site that made the request; a request without the header (not a browser) is let through. */
function isCrossSite(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  return site !== null && !ALLOWED_FETCH_SITES.includes(site);
}

/** An HTML form cannot send JSON, and another site's script can only after a CORS preflight, which is never granted. */
function isJson(request: Request): boolean {
  return (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase() === "application/json";
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
  // These refusals (403, 415, 413) come before the limit check: they are not guesses at the password, so they do not count.
  if (isCrossSite(request)) return Response.json({ error: "cross-site request refused" }, { status: 403 });
  if (!isJson(request)) return Response.json({ error: "content-type must be application/json" }, { status: 415 });
  const body = await readCappedBody(request);
  if (body === null) return Response.json({ error: "request too large" }, { status: 413 });
  // The body is read first so that nothing awaits between this check and recording the failure: concurrent attempts are
  // counted one at a time.
  if (!loginLimiter.allowGlobal() || !loginLimiter.allow(ip)) {
    return Response.json({ error: "too many attempts, try later" }, { status: 429, headers: { "retry-after": String(LOGIN_RETRY_AFTER_SEC) } });
  }
  if (!checkPassword(passwordFrom(body))) {
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
