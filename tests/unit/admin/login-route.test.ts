import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { POST, DELETE } from "@/app/api/admin/login/route";
import { loginLimiter, ADMIN_COOKIE, resetLoginLimiterForTests } from "@/server/admin/auth";
import { log } from "@/server/log";

const post = (password: string, ip = "9.9.9.9") =>
  POST(new Request("http://localhost/api/admin/login", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: JSON.stringify({ password }) }));

describe("POST /api/admin/login", () => {
  beforeEach(() => loginLimiter.reset("9.9.9.9"));
  it("sets the cookie on success", async () => {
    const res = await post("test-admin");
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${ADMIN_COOKIE}=`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
  });
  it("rejects a wrong password and rate limits", async () => {
    for (let i = 0; i < 5; i++) expect((await post("wrong")).status).toBe(401);
    expect((await post("test-admin")).status).toBe(429);
  });
  it("clears the cookie on logout", async () => {
    const res = await DELETE();
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
  });
});

const postBody = (body: string, ip: string, headers: Record<string, string> = {}) =>
  POST(new Request("http://localhost/api/admin/login", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip, ...headers }, body }));
/** A JSON login body of exactly `bytes` bytes. */
const bodyOf = (bytes: number) => JSON.stringify({ password: "x".repeat(bytes - '{"password":""}'.length) });

describe("POST /api/admin/login: request hygiene and the global backstop", () => {
  beforeEach(() => resetLoginLimiterForTests());
  afterEach(() => {
    vi.restoreAllMocks();
    resetLoginLimiterForTests();
  });

  it("refuses a body over 4 KB with 413, unread when declared, and does not count it as an attempt", async () => {
    expect(Buffer.byteLength(bodyOf(4097))).toBe(4097);
    for (let i = 0; i < 6; i++) expect((await postBody(bodyOf(4097), "8.8.8.8")).status).toBe(413);
    const declared = new Request("http://localhost/api/admin/login", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "8.8.8.8", "content-length": "5000" },
      body: JSON.stringify({ password: "test-admin" }),
    });
    expect((await POST(declared)).status).toBe(413);
    expect(declared.bodyUsed).toBe(false);
    expect((await post("test-admin", "8.8.8.8")).status).toBe(200);
  });

  it("reads a body of exactly 4 KB", async () => {
    expect(Buffer.byteLength(bodyOf(4096))).toBe(4096);
    expect((await postBody(bodyOf(4096), "8.8.8.8")).status).toBe(401);
  });

  it("treats a malformed body as a wrong password and counts it", async () => {
    for (const body of ["not json", "", "null", '["test-admin"]', '{"password":123}']) expect((await postBody(body, "7.7.7.7")).status).toBe(401);
    expect((await post("test-admin", "7.7.7.7")).status).toBe(429);
  });

  it("counts concurrent attempts one at a time", async () => {
    const statuses = (await Promise.all(Array.from({ length: 12 }, () => post("wrong", "6.6.6.6")))).map((r) => r.status);
    expect(statuses.sort((a, b) => a - b)).toEqual([...Array(5).fill(401), ...Array(7).fill(429)]);
  });

  it("refuses every ip once 50 failures came from anywhere, and logs that lockout once", async () => {
    const info = vi.spyOn(log, "info").mockImplementation(() => undefined);
    for (let i = 0; i < 50; i++) expect((await post("wrong", `10.0.0.${i}`)).status).toBe(401);
    expect((await post("test-admin", "10.0.1.1")).status).toBe(429);
    expect(info.mock.calls).toEqual([[{ ip: "10.0.0.49" }, "admin login locked out for every ip"]]);
  });

  it("logs a success and a lockout with the ip only, and never the password or the body", async () => {
    const spies = {
      trace: vi.spyOn(log, "trace").mockImplementation(() => undefined),
      debug: vi.spyOn(log, "debug").mockImplementation(() => undefined),
      info: vi.spyOn(log, "info").mockImplementation(() => undefined),
      warn: vi.spyOn(log, "warn").mockImplementation(() => undefined),
      error: vi.spyOn(log, "error").mockImplementation(() => undefined),
      fatal: vi.spyOn(log, "fatal").mockImplementation(() => undefined),
    };
    expect((await post("test-admin", "5.5.5.5")).status).toBe(200);
    for (let i = 0; i < 5; i++) expect((await postBody(JSON.stringify({ password: `guess-${i}`, note: "body-secret" }), "5.5.5.6")).status).toBe(401);
    expect((await postBody("body-secret, not json", "5.5.5.7")).status).toBe(401);
    expect((await postBody(JSON.stringify({ password: "body-secret".repeat(500) }), "5.5.5.8")).status).toBe(413);
    expect(spies.info.mock.calls).toEqual([
      [{ ip: "5.5.5.5" }, "admin login"],
      [{ ip: "5.5.5.6" }, "admin login locked out"],
    ]);
    expect(JSON.stringify(Object.values(spies).map((s) => s.mock.calls))).not.toMatch(/test-admin|guess-|body-secret/);
  });
});
