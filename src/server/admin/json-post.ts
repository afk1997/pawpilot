/** The admin page's JSON posts are a few fields; anything bigger is refused. */
const MAX_BODY_BYTES = 4 * 1024;
/**
 * What a browser sends for a request from our own page or a typed address. Any other value means another page made it,
 * "same-site" included: a sibling subdomain is not this admin page.
 */
const ALLOWED_FETCH_SITES = ["same-origin", "none"];

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
 * stops at the first chunk past the cap. A body that fails mid-read comes back empty.
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

/** The body parsed as a JSON object; anything else (not JSON, an array, null, a number) reads as no fields at all. */
function objectFrom(body: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(body);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * The fields of an admin JSON post, or the refusal to return instead, checked as the login route checks: 403 when
 * another site made the request, 415 when the body is not declared as JSON, 413 when it is over 4 KB.
 */
export async function readAdminJsonPost(request: Request): Promise<Record<string, unknown> | Response> {
  if (isCrossSite(request)) return Response.json({ error: "cross-site request refused" }, { status: 403 });
  if (!isJson(request)) return Response.json({ error: "content-type must be application/json" }, { status: 415 });
  const body = await readCappedBody(request);
  if (body === null) return Response.json({ error: "request too large" }, { status: 413 });
  return objectFrom(body);
}
