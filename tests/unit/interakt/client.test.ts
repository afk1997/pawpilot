import { describe, it, expect, afterEach, vi } from "vitest";
import { resetConfigForTests } from "@/server/config";
import { log } from "@/server/log";
import { splitPhone, isTestPhone, sendText, sendInteractiveList, setFetchForTests } from "@/server/interakt/client";

const okFetch = (captured: { url?: string; init?: RequestInit }) =>
  (async (url: string | URL | Request, init?: RequestInit) => {
    captured.url = String(url);
    captured.init = init;
    return new Response(JSON.stringify({ result: true, id: "msg-1", message: "queued" }), { status: 201, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

describe("splitPhone", () => {
  it("handles Indian and international shapes", () => {
    expect(splitPhone("+919096820338")).toEqual({ countryCode: "+91", phoneNumber: "9096820338" });
    expect(splitPhone("9096820338")).toEqual({ countryCode: "+91", phoneNumber: "9096820338" });
    expect(splitPhone("09096820338")).toEqual({ countryCode: "+91", phoneNumber: "9096820338" });
    expect(splitPhone("+447911123456")).toEqual({ countryCode: "+44", phoneNumber: "7911123456" });
  });
  it("honours an explicit country code instead of assuming India", () => {
    expect(splitPhone("+6581234567")).toEqual({ countryCode: "+65", phoneNumber: "81234567" });
    expect(splitPhone("+971501234567")).toEqual({ countryCode: "+971", phoneNumber: "501234567" });
    expect(splitPhone("+14155552671")).toEqual({ countryCode: "+1", phoneNumber: "4155552671" });
    expect(splitPhone("+79161234567")).toEqual({ countryCode: "+7", phoneNumber: "9161234567" });
    expect(splitPhone("+93701234567")).toEqual({ countryCode: "+93", phoneNumber: "701234567" });
  });
  it("recognises test phones", () => {
    expect(isTestPhone("+91TEST_abc123")).toBe(true);
    expect(isTestPhone("+919096820338")).toBe(false);
  });
});

describe("send functions", () => {
  afterEach(() => {
    setFetchForTests(null);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    resetConfigForTests();
  });

  it("posts a Text payload with Basic auth and returns the message id", async () => {
    const cap: { url?: string; init?: RequestInit } = {};
    setFetchForTests(okFetch(cap));
    const r = await sendText("+919096820338", "hello");
    expect(r.ok).toBe(true);
    expect(r.messageId).toBe("msg-1");
    expect(cap.url).toBe("https://api.interakt.ai/v1/public/message/");
    const headers = cap.init!.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Basic test-interakt-key");
    expect(JSON.parse(String(cap.init!.body))).toEqual({
      countryCode: "+91", phoneNumber: "9096820338", type: "Text", callbackData: "agent", data: { message: "hello" },
    });
  });

  it("posts an InteractiveList payload", async () => {
    const cap: { url?: string; init?: RequestInit } = {};
    setFetchForTests(okFetch(cap));
    await sendInteractiveList("+919096820338", { body: "Pick one", buttonLabel: "Options", rows: [{ id: "menu:ambulance", title: "Animal ambulance" }] });
    expect(JSON.parse(String(cap.init!.body))).toEqual({
      countryCode: "+91",
      phoneNumber: "9096820338",
      type: "InteractiveList",
      callbackData: "agent",
      data: {
        message: {
          type: "list",
          body: { text: "Pick one" },
          action: { button: "Options", sections: [{ title: "Options", rows: [{ id: "menu:ambulance", title: "Animal ambulance" }] }] },
        },
      },
    });
  });

  it("refuses to send to a test phone without calling fetch", async () => {
    let called = false;
    setFetchForTests((async () => { called = true; return new Response("{}", { status: 201 }); }) as typeof fetch);
    const r = await sendText("+91TEST_abc", "hi");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/test phone/);
    expect(called).toBe(false);
  });

  it("reports HTTP failures and thrown errors without throwing", async () => {
    setFetchForTests((async () => new Response(JSON.stringify({ message: "Customer has not messaged within last 24 hours" }), { status: 400 })) as typeof fetch);
    const r = await sendText("+919096820338", "hello");
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
    expect(r.error).toMatch(/^interakt 400:/);
    setFetchForTests((async () => {
      throw new TypeError("fetch failed", { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) });
    }) as typeof fetch);
    const r2 = await sendText("+919096820338", "hello");
    expect(r2.ok).toBe(false);
    expect(r2.error).toMatch(/ECONNRESET/);
    setFetchForTests((async () => {
      throw new TypeError("fetch failed", { cause: Object.assign(new AggregateError([], ""), { code: "ECONNREFUSED" }) });
    }) as typeof fetch);
    const r3 = await sendText("+919096820338", "hello");
    expect(r3.error).toBe("fetch failed: ECONNREFUSED");
  });

  it("logs only the masked, normalized phone", async () => {
    const warn = vi.spyOn(log, "warn");
    const error = vi.spyOn(log, "error");
    setFetchForTests((async () => new Response("{}", { status: 400 })) as typeof fetch);
    await sendText("+91 70000 00001", "hello");
    expect(warn).toHaveBeenCalledWith({ to: "+91xxxxxx0001", status: 400 }, "interakt send failed");
    setFetchForTests((async () => { throw new Error("boom"); }) as typeof fetch);
    await sendText("+91 70000 00001", "hello");
    expect(error).toHaveBeenCalledWith({ to: "+91xxxxxx0001", error: "boom" }, "interakt send threw");
  });

  it("times sends out after 15 s and reports the abort without throwing", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    let signal: AbortSignal | null | undefined;
    setFetchForTests((async (_url: string | URL | Request, init?: RequestInit) => {
      signal = init?.signal;
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    }) as typeof fetch);
    const r = await sendText("+919096820338", "hello");
    expect(timeout).toHaveBeenCalledWith(15_000);
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal).toBe(timeout.mock.results[0]?.value);
    expect(r).toMatchObject({ ok: false, status: 0 });
    expect(r.error).toBe("The operation was aborted due to timeout");
  });

  it("returns a failure instead of throwing when the environment is invalid", async () => {
    vi.stubEnv("INTERAKT_API_KEY", "");
    resetConfigForTests();
    let called = false;
    setFetchForTests((async () => { called = true; return new Response("{}", { status: 201 }); }) as typeof fetch);
    const r = await sendText("+919096820338", "hello");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/INTERAKT_API_KEY/);
    expect(called).toBe(false);
  });
});
