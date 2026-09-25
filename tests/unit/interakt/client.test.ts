import { describe, it, expect, afterEach } from "vitest";
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
  it("recognises test phones", () => {
    expect(isTestPhone("+91TEST_abc123")).toBe(true);
    expect(isTestPhone("+919096820338")).toBe(false);
  });
});

describe("send functions", () => {
  afterEach(() => setFetchForTests(null));

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
    const body = JSON.parse(String(cap.init!.body));
    expect(body.type).toBe("InteractiveList");
    expect(body.data.message.type).toBe("list");
    expect(body.data.message.action.button).toBe("Options");
    expect(body.data.message.action.sections[0].rows[0]).toEqual({ id: "menu:ambulance", title: "Animal ambulance" });
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
    setFetchForTests((async () => { throw new Error("ECONNRESET"); }) as typeof fetch);
    const r2 = await sendText("+919096820338", "hello");
    expect(r2.ok).toBe(false);
    expect(r2.error).toMatch(/ECONNRESET/);
  });
});
