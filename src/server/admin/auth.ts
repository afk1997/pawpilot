import { createHmac, timingSafeEqual } from "node:crypto";
import { getConfig } from "../config";

export const ADMIN_COOKIE = "arham_admin";
const MAX_FAILURES = 5;
/** Across every ip: x-forwarded-for is client-supplied, so a client reaching the app directly can rotate past MAX_FAILURES. */
const MAX_GLOBAL_FAILURES = 50;
const WINDOW_MS = 15 * 60 * 1000;

function hmac(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

export function signAdminSession(expiresAtMs: number): string {
  const exp = String(Math.floor(expiresAtMs));
  return `${exp}.${hmac(exp, getConfig().admin.sessionSecret)}`;
}

export function verifyAdminSession(value: string | null | undefined, nowMs: number = Date.now()): boolean {
  if (!value) return false;
  const dot = value.indexOf(".");
  if (dot <= 0) return false;
  const exp = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  if (!/^\d+$/.test(exp) || Number(exp) < nowMs) return false;
  const expected = hmac(exp, getConfig().admin.sessionSecret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function checkPassword(candidate: string): boolean {
  const expected = getConfig().admin.password;
  const a = Buffer.from(candidate ?? "");
  const b = Buffer.from(expected);
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

const failures = new Map<string, number[]>();
let globalFailures: number[] = [];
export const loginLimiter = {
  allow(ip: string, nowMs: number = Date.now()): boolean {
    const recent = (failures.get(ip) ?? []).filter((t) => nowMs - t < WINDOW_MS);
    failures.set(ip, recent);
    return recent.length < MAX_FAILURES;
  },
  /** The backstop: false while MAX_GLOBAL_FAILURES failures, from any ips, fall inside the window. */
  allowGlobal(nowMs: number = Date.now()): boolean {
    globalFailures = globalFailures.filter((t) => nowMs - t < WINDOW_MS);
    return globalFailures.length < MAX_GLOBAL_FAILURES;
  },
  /** Counts against the ip and against the backstop. */
  recordFailure(ip: string, nowMs: number = Date.now()): void {
    failures.set(ip, [...(failures.get(ip) ?? []), nowMs]);
    globalFailures.push(nowMs);
  },
  /** Clears the ip's own failures after a successful login; the backstop keeps its count. */
  reset(ip: string): void {
    failures.delete(ip);
  },
};

/** Tests share this process-wide state; call this to start from no failures. */
export function resetLoginLimiterForTests(): void {
  failures.clear();
  globalFailures = [];
}

export function cookieHeaderValue(token: string, maxAgeSec: number): string {
  const secure = getConfig().isProduction ? "; Secure" : "";
  return `${ADMIN_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`;
}

function cookieFromHeader(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === ADMIN_COOKIE) return rest.join("=");
  }
  return null;
}

export function isAdminRequest(request: Request): boolean {
  return verifyAdminSession(cookieFromHeader(request.headers.get("cookie")));
}

export function unauthorized(): Response {
  return Response.json({ error: "unauthorized" }, { status: 401 });
}

/** Server components: redirect to the login page when the cookie is missing or invalid. */
export async function requireAdmin(): Promise<void> {
  const { cookies } = await import("next/headers");
  const { redirect } = await import("next/navigation");
  const store = await cookies();
  if (!verifyAdminSession(store.get(ADMIN_COOKIE)?.value)) redirect("/admin/login");
}
