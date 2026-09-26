/** The default cap on an admin JSON post: its fields are a few short values. */
const DEFAULT_MAX_BODY_BYTES = 4 * 1024;
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

const TOO_LARGE = Symbol("too large");
const UNREADABLE = Symbol("unreadable");

/**
 * The body as text; TOO_LARGE when it is over `maxBytes` (a declared oversized body is refused unread, and reading
 * stops at the first chunk past the cap); UNREADABLE when it fails mid-read.
 */
async function readCappedBody(request: Request, maxBytes: number): Promise<string | typeof TOO_LARGE | typeof UNREADABLE> {
  if (Number(request.headers.get("content-length")) > maxBytes) return TOO_LARGE;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        void reader.cancel().catch(() => undefined);
        return TOO_LARGE;
      }
      chunks.push(value);
    }
  } catch {
    return UNREADABLE;
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** The body parsed as a JSON object; null for anything else (not JSON, or an array, null, number or string). */
function objectFrom(body: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(body);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The fields of an admin JSON post, or the refusal to return instead: 403 when another site made the request, 415 when
 * the body is not declared as JSON, 413 when it is over `maxBytes` (default 4 KB; a route taking longer text passes its
 * own), 400 when it cannot be read or is not a JSON object.
 */
export async function readAdminJsonPost(
  request: Request,
  { maxBytes = DEFAULT_MAX_BODY_BYTES }: { maxBytes?: number } = {}
): Promise<Record<string, unknown> | Response> {
  if (isCrossSite(request)) return Response.json({ error: "cross-site request refused" }, { status: 403 });
  if (!isJson(request)) return Response.json({ error: "content-type must be application/json" }, { status: 415 });
  const body = await readCappedBody(request, maxBytes);
  if (body === TOO_LARGE) return Response.json({ error: "request too large" }, { status: 413 });
  if (body === UNREADABLE) return Response.json({ error: "body could not be read" }, { status: 400 });
  return objectFrom(body) ?? Response.json({ error: "body must be a JSON object" }, { status: 400 });
}
