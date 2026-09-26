import { describe, it, expect, beforeEach, vi } from "vitest";
import { signAdminSession, verifyAdminSession, checkPassword, loginLimiter, isAdminRequest, ADMIN_COOKIE, requireAdmin, resetLoginLimiterForTests } from "@/server/admin/auth";

// requireAdmin's Next APIs: a cookie jar the tests fill, and a redirect that throws the way Next's does.
const nextApis = vi.hoisted(() => ({
  cookies: new Map<string, string>(),
  redirect: vi.fn((url: string): never => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  }),
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = nextApis.cookies.get(name);
      return value === undefined ? undefined : { name, value };
    },
  }),
}));
vi.mock("next/navigation", () => ({ redirect: nextApis.redirect }));

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

describe("requireAdmin", () => {
  beforeEach(() => {
    nextApis.cookies.clear();
    nextApis.redirect.mockClear();
  });

  it("returns for a valid session cookie", async () => {
    nextApis.cookies.set(ADMIN_COOKIE, signAdminSession(Date.now() + 60_000));
    await expect(requireAdmin()).resolves.toBeUndefined();
    expect(nextApis.redirect).not.toHaveBeenCalled();
  });

  it("redirects to the login page without a valid cookie, and lets the redirect's throw propagate", async () => {
    await expect(requireAdmin()).rejects.toThrow("NEXT_REDIRECT /admin/login");
    nextApis.cookies.set(ADMIN_COOKIE, signAdminSession(Date.now() - 1_000));
    await expect(requireAdmin()).rejects.toThrow("NEXT_REDIRECT /admin/login");
    expect(nextApis.redirect).toHaveBeenCalledTimes(2);
    expect(nextApis.redirect).toHaveBeenCalledWith("/admin/login");
  });
});
