import { describe, it, expect, beforeEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { resetConfigForTests } from "@/server/config";
import { signAdminSession, verifyAdminSession, checkPassword, loginLimiter, isAdminRequest, ADMIN_COOKIE, requireAdmin, resetLoginLimiterForTests, trackedIpCountForTests } from "@/server/admin/auth";

// requireAdmin's Next APIs: the request's raw cookie header, which the tests set, and a redirect that throws the way Next's does.
const nextApis = vi.hoisted(() => ({
  cookieHeader: null as string | null,
  redirect: vi.fn((url: string): never => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  }),
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(nextApis.cookieHeader === null ? {} : { cookie: nextApis.cookieHeader }),
}));
vi.mock("next/navigation", () => ({ redirect: nextApis.redirect }));

/** Runs `fn` against a fresh config built with `env` stubbed in, then restores the environment and the config. */
function withEnv<T>(env: Record<string, string>, fn: () => T): T {
  try {
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    resetConfigForTests();
    return fn();
  } finally {
    vi.unstubAllEnvs();
    resetConfigForTests();
  }
}

describe("admin session", () => {
  it("round-trips a signed session and rejects expiry and tampering", () => {
    const token = signAdminSession(Date.now() + 60_000);
    expect(verifyAdminSession(token)).toBe(true);
    expect(verifyAdminSession(token, Date.now() + 120_000)).toBe(false);
    expect(verifyAdminSession(token.slice(0, -2) + "zz")).toBe(false);
    expect(verifyAdminSession("garbage")).toBe(false);
    expect(verifyAdminSession(null)).toBe(false);
  });
  it("checks the password in constant time", () => {
    expect(checkPassword("test-admin")).toBe(true);
    expect(checkPassword("nope")).toBe(false);
    expect(checkPassword("")).toBe(false);
  });
  it("rate limits five failures per 15 minutes per ip", () => {
    loginLimiter.reset("1.2.3.4");
    const t0 = 1_000_000;
    for (let i = 0; i < 5; i++) { expect(loginLimiter.allow("1.2.3.4", t0)).toBe(true); loginLimiter.recordFailure("1.2.3.4", t0); }
    expect(loginLimiter.allow("1.2.3.4", t0 + 1000)).toBe(false);
    expect(loginLimiter.allow("1.2.3.4", t0 + 16 * 60_000)).toBe(true);
  });
  it("reads the cookie from a Request", () => {
    const token = signAdminSession(Date.now() + 60_000);
    expect(isAdminRequest(new Request("http://x/", { headers: { cookie: `${ADMIN_COOKIE}=${token}; other=1` } }))).toBe(true);
    expect(isAdminRequest(new Request("http://x/"))).toBe(false);
  });
});

describe("admin session: pinned security properties", () => {
  const token = () => signAdminSession(Date.now() + 60_000);

  it("rejects a wrong password of the same length", () => {
    expect(checkPassword("test-admiN")).toBe(false);
  });

  it("rejects a bumped expiry, an unkeyed digest and another secret's signature", () => {
    const [exp, sig] = token().split(".");
    expect(verifyAdminSession(`${exp}.${sig}`)).toBe(true); // control
    expect(verifyAdminSession(`${Number(exp) + 60_000}.${sig}`)).toBe(false);
    expect(verifyAdminSession(`${exp}.${createHash("sha256").update(exp).digest("hex")}`)).toBe(false);
    const foreign = withEnv({ SESSION_SECRET: "another-secret-that-is-32-chars!" }, token);
    expect(verifyAdminSession(foreign)).toBe(false);
  });

  it("revokes every session when the admin password changes", () => {
    const issued = token();
    withEnv({ ADMIN_PASSWORD: "a-new-admin-password" }, () => expect(verifyAdminSession(issued)).toBe(false));
    expect(verifyAdminSession(issued)).toBe(true); // the old password is back
  });
});

describe("admin cookie parsing", () => {
  const valid = () => signAdminSession(Date.now() + 60_000);
  const withCookie = (cookie: string) => new Request("http://x/", { headers: { cookie } });

  it("finds the admin cookie when it is not first", () => {
    expect(isAdminRequest(withCookie(`other=1; ${ADMIN_COOKIE}=${valid()}`))).toBe(true);
  });

  it("admits the request when any duplicate admin cookie is valid, the valid one second", () => {
    expect(isAdminRequest(withCookie(`${ADMIN_COOKIE}=1.stale; ${ADMIN_COOKIE}=${valid()}`))).toBe(true);
    expect(isAdminRequest(withCookie(`${ADMIN_COOKIE}=1.stale; ${ADMIN_COOKIE}=also-stale`))).toBe(false);
  });

  it("unquotes a quoted value, keeps a value's own = signs, and is not confused by other cookies' = signs", () => {
    expect(isAdminRequest(withCookie(`${ADMIN_COOKIE}="${valid()}"`))).toBe(true);
    expect(isAdminRequest(withCookie(`theme=a=b; ${ADMIN_COOKIE}=${valid()}`))).toBe(true);
    expect(isAdminRequest(withCookie(`${ADMIN_COOKIE}=${valid()}=x`))).toBe(false);
  });
});

describe("global login backstop", () => {
  beforeEach(() => resetLoginLimiterForTests());

  it("refuses a fresh ip after 50 failures from 50 ips in 15 minutes, until the window passes", () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 50; i++) {
      expect(loginLimiter.allowGlobal(t0)).toBe(true);
      loginLimiter.recordFailure(`10.0.0.${i}`, t0);
    }
    expect(loginLimiter.allow("10.0.1.1", t0 + 1000)).toBe(true); // the fresh ip has no failures of its own
    expect(loginLimiter.allowGlobal(t0 + 1000)).toBe(false);
    expect(loginLimiter.allowGlobal(t0 + 16 * 60_000)).toBe(true);
  });

  it("slides: each failure leaves the count 15 minutes after it happened", () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 25; i++) loginLimiter.recordFailure(`10.0.0.${i}`, t0);
    for (let i = 25; i < 50; i++) loginLimiter.recordFailure(`10.0.0.${i}`, t0 + 10 * 60_000);
    expect(loginLimiter.allowGlobal(t0 + 14 * 60_000)).toBe(false);
    expect(loginLimiter.allowGlobal(t0 + 15 * 60_000)).toBe(true);
    for (let i = 0; i < 25; i++) loginLimiter.recordFailure(`10.0.1.${i}`, t0 + 15 * 60_000);
    expect(loginLimiter.allowGlobal(t0 + 15 * 60_000)).toBe(false);
  });

  it("is not cleared by one ip's successful login", () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 50; i++) loginLimiter.recordFailure(`10.0.0.${i}`, t0);
    loginLimiter.reset("10.0.0.0");
    expect(loginLimiter.allowGlobal(t0 + 1000)).toBe(false);
  });
});

describe("login limiter keys", () => {
  beforeEach(() => resetLoginLimiterForTests());
  const t0 = 1_000_000;

  it("keys an IPv6 address by its /64", () => {
    for (let i = 1; i <= 5; i++) loginLimiter.recordFailure(`2001:db8:aa:bb::${i}`, t0);
    expect(loginLimiter.allow("2001:db8:aa:bb:ffff:1:2:3", t0)).toBe(false);
    expect(loginLimiter.allow("2001:0DB8:00aa:00bb::9", t0)).toBe(false); // the same /64, written out
    expect(loginLimiter.allow("2001:db8:aa:bc::1", t0)).toBe(true); // the next /64
    loginLimiter.reset("2001:db8:aa:bb::77");
    expect(loginLimiter.allow("2001:db8:aa:bb::1", t0)).toBe(true);
  });

  it("keys an IPv4-mapped IPv6 address by its IPv4 address, so mapped clients do not share one bucket", () => {
    for (let i = 0; i < 5; i++) loginLimiter.recordFailure("::ffff:198.51.100.7", t0);
    expect(loginLimiter.allow("198.51.100.7", t0)).toBe(false);
    expect(loginLimiter.allow("::ffff:c633:6407", t0)).toBe(false); // the same address in hex
    expect(loginLimiter.allow("::ffff:198.51.100.8", t0)).toBe(true);
  });

  it("caps keys at 64 characters", () => {
    const long = "x".repeat(64);
    for (let i = 0; i < 5; i++) loginLimiter.recordFailure(`${long}-${i}`, t0);
    expect(loginLimiter.allow(`${long}-other`, t0)).toBe(false);
  });

  it("prunes expired ips once it tracks more than 500, and keeps live ones", () => {
    for (let i = 0; i < 500; i++) loginLimiter.recordFailure(`10.1.${i >> 8}.${i & 255}`, t0);
    expect(trackedIpCountForTests()).toBe(500);
    loginLimiter.recordFailure("10.2.0.1", t0 + 10 * 60_000);
    expect(trackedIpCountForTests()).toBe(501); // over 500, but nothing has expired yet
    loginLimiter.recordFailure("10.2.0.2", t0 + 15 * 60_000);
    expect(trackedIpCountForTests()).toBe(2);
  });

  it("never tracks an ip without failures, and drops one whose failures expired when it is next seen", () => {
    loginLimiter.allow("10.3.0.1", t0);
    expect(trackedIpCountForTests()).toBe(0);
    loginLimiter.recordFailure("10.3.0.1", t0);
    expect(trackedIpCountForTests()).toBe(1);
    expect(loginLimiter.allow("10.3.0.1", t0 + 15 * 60_000)).toBe(true);
    expect(trackedIpCountForTests()).toBe(0);
  });
});

describe("requireAdmin", () => {
  beforeEach(() => {
    nextApis.cookieHeader = null;
    nextApis.redirect.mockClear();
  });

  it("returns for a valid session cookie, read by the shared parser from the raw header", async () => {
    nextApis.cookieHeader = `other=1; ${ADMIN_COOKIE}=1.stale; ${ADMIN_COOKIE}=${signAdminSession(Date.now() + 60_000)}`;
    await expect(requireAdmin()).resolves.toBeUndefined();
    expect(nextApis.redirect).not.toHaveBeenCalled();
  });

  it("redirects to the login page without a valid cookie, and lets the redirect's throw propagate", async () => {
    await expect(requireAdmin()).rejects.toThrow("NEXT_REDIRECT /admin/login");
    nextApis.cookieHeader = `${ADMIN_COOKIE}=${signAdminSession(Date.now() - 1_000)}`;
    await expect(requireAdmin()).rejects.toThrow("NEXT_REDIRECT /admin/login");
    expect(nextApis.redirect).toHaveBeenCalledTimes(2);
    expect(nextApis.redirect).toHaveBeenCalledWith("/admin/login");
  });
});
