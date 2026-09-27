import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { isIPv6 } from "node:net";
import { getConfig } from "../config";

export const ADMIN_COOKIE = "arham_admin";
const MAX_FAILURES = 5;
/** Across every ip: x-forwarded-for is client-supplied, so a client reaching the app directly can rotate past MAX_FAILURES. */
const MAX_GLOBAL_FAILURES = 50;
const WINDOW_MS = 15 * 60 * 1000;
/** What a refused client is told to wait: the whole window, the longest a lockout can last. */
export const LOGIN_RETRY_AFTER_SEC = WINDOW_MS / 1000;
/** Once the per-ip map holds more than this many ips, recording a failure also sweeps out those whose failures all expired. */
const MAX_TRACKED_IPS = 500;
const MAX_KEY_LENGTH = 64;

/** Derived from the session secret and the admin password, so changing either one revokes every session. */
function sessionKey(): Buffer {
  const { password, sessionSecret } = getConfig().admin;
  return createHmac("sha256", sessionSecret).update(password).digest();
}

function hmac(payload: string, key: Buffer): string {
  return createHmac("sha256", key).update(payload).digest("hex");
}

export function signAdminSession(expiresAtMs: number): string {
  const exp = String(Math.floor(expiresAtMs));
  return `${exp}.${hmac(exp, sessionKey())}`;
}

export function verifyAdminSession(value: string | null | undefined, nowMs: number = Date.now()): boolean {
  if (!value) return false;
  const dot = value.indexOf(".");
  if (dot <= 0) return false;
  const exp = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  if (!/^\d+$/.test(exp) || Number(exp) < nowMs) return false;
  const expected = hmac(exp, sessionKey());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

const sha256 = (text: string): Buffer => createHash("sha256").update(text).digest();

/** Compares fixed-length digests, so the time taken says nothing about the password's length or where a guess differs. */
export function checkPassword(candidate: string): boolean {
  const value = candidate ?? "";
  return value.length > 0 && timingSafeEqual(sha256(value), sha256(getConfig().admin.password));
}

/**
 * The limiter's bucket for a client address, at most 64 characters. Brackets and a port come off first. An IPv6
 * address counts by its /64, which one subscriber usually holds whole; an IPv4-mapped one counts by its IPv4 address;
 * anything else counts as written.
 */
function limiterKey(ip: string): string {
  const address = withoutPort(ip.trim());
  return (ipv6Bucket(address) ?? address).slice(0, MAX_KEY_LENGTH);
}

/** "[2001:db8::1]:443" and "[2001:db8::1]" → "2001:db8::1"; "1.2.3.4:5678" → "1.2.3.4"; anything else as written. */
function withoutPort(ip: string): string {
  const bracketed = ip.match(/^\[([^\]]*)\](?::\d+)?$/);
  if (bracketed) return bracketed[1];
  const v4 = ip.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
  return v4 ? v4[1] : ip;
}

/** "2001:db8:1:2:3:4:5:6" → "2001:db8:1:2::/64" and "::ffff:1.2.3.4" → "1.2.3.4"; null when `ip` is not IPv6. */
function ipv6Bucket(ip: string): string | null {
  if (!isIPv6(ip)) return null;
  let text = ip.split("%")[0]; // no zone id
  const v4 = text.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number);
    text = `${text.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.split("::");
  const headGroups = head ? head.split(":") : [];
  const tailGroups = tail ? tail.split(":") : [];
  const zeros = tail === undefined ? [] : Array<string>(8 - headGroups.length - tailGroups.length).fill("0");
  const g = [...headGroups, ...zeros, ...tailGroups].map((group) => parseInt(group, 16));
  if (g.slice(0, 5).every((group) => group === 0) && g[5] === 0xffff) return `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
  return `${g.slice(0, 4).map((group) => group.toString(16)).join(":")}::/64`;
}

const failures = new Map<string, number[]>();
let globalFailures: number[] = [];

function pruneExpired(nowMs: number): void {
  for (const [key, times] of failures) if (!times.some((t) => nowMs - t < WINDOW_MS)) failures.delete(key);
}

export const loginLimiter = {
  allow(ip: string, nowMs: number = Date.now()): boolean {
    const key = limiterKey(ip);
    const recent = (failures.get(key) ?? []).filter((t) => nowMs - t < WINDOW_MS);
    if (recent.length > 0) failures.set(key, recent);
    else failures.delete(key);
    return recent.length < MAX_FAILURES;
  },
  /** The backstop: false while MAX_GLOBAL_FAILURES failures, from any ips, fall inside the window. */
  allowGlobal(nowMs: number = Date.now()): boolean {
    globalFailures = globalFailures.filter((t) => nowMs - t < WINDOW_MS);
    return globalFailures.length < MAX_GLOBAL_FAILURES;
  },
  /** Counts against the ip and against the backstop. */
  recordFailure(ip: string, nowMs: number = Date.now()): void {
    const key = limiterKey(ip);
    failures.set(key, [...(failures.get(key) ?? []), nowMs]);
    globalFailures.push(nowMs);
    if (failures.size > MAX_TRACKED_IPS) pruneExpired(nowMs);
  },
  /** Clears the ip's own failures after a successful login; the backstop keeps its count. */
  reset(ip: string): void {
    failures.delete(limiterKey(ip));
  },
};

/** Tests share this process-wide state; call this to start from no failures. */
export function resetLoginLimiterForTests(): void {
  failures.clear();
  globalFailures = [];
}

/** How many ips the per-ip map holds, for the pruning tests. */
export function trackedIpCountForTests(): number {
  return failures.size;
}

export function cookieHeaderValue(token: string, maxAgeSec: number): string {
  const secure = getConfig().isProduction ? "; Secure" : "";
  return `${ADMIN_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`;
}

/** Every ADMIN_COOKIE value in a raw cookie header, in order, each taken whole after its first "=" and unquoted. */
function adminCookieValues(header: string | null): string[] {
  if (!header) return [];
  const values: string[] = [];
  for (const pair of header.split(";")) {
    const eq = pair.indexOf("=");
    if (eq < 0 || pair.slice(0, eq).trim() !== ADMIN_COOKIE) continue;
    const value = pair.slice(eq + 1).trim();
    values.push(value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value);
  }
  return values;
}

/** True when any admin cookie in the header is a valid session: a browser holding one per path or domain sends them all. */
function hasAdminSession(cookieHeader: string | null): boolean {
  return adminCookieValues(cookieHeader).some((value) => verifyAdminSession(value));
}

export function isAdminRequest(request: Request): boolean {
  return hasAdminSession(request.headers.get("cookie"));
}

export function unauthorized(): Response {
  return Response.json({ error: "unauthorized" }, { status: 401 });
}

/** Server components: redirect to the login page when no admin cookie is valid. The redirect throws; do not catch it. */
export async function requireAdmin(): Promise<void> {
  const { headers } = await import("next/headers");
  const { redirect } = await import("next/navigation");
  const requestHeaders = await headers();
  if (!hasAdminSession(requestHeaders.get("cookie"))) redirect("/admin/login");
}
