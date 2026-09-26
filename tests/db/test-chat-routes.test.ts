import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createConversation, resetDb } from "../helpers/db";
import * as boss from "@/server/queue/boss";
import { stopBoss, getBoss, TURN_QUEUE } from "@/server/queue/boss";
import { signAdminSession, ADMIN_COOKIE } from "@/server/admin/auth";
import { getDb } from "@/server/db/client";
import { messages } from "@/server/db/schema";
import { log } from "@/server/log";
import { GET as list, POST as create } from "@/app/api/test-chat/conversations/route";
import { GET as detail } from "@/app/api/test-chat/conversations/[id]/route";
import { POST as send } from "@/app/api/test-chat/conversations/[id]/messages/route";

const cookie = () => ({ cookie: `${ADMIN_COOKIE}=${signAdminSession(Date.now() + 60_000)}` });
const req = (url: string, init: RequestInit = {}) => new Request(url, { ...init, headers: { "content-type": "application/json", ...cookie(), ...(init.headers ?? {}) } });
const LIST_URL = "http://x/api/test-chat/conversations";
const messagesUrl = (id: string) => `${LIST_URL}/${id}/messages`;
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const listIds = async () => (await (await list(req(LIST_URL))).json()).map((r: { id: string }) => r.id);

describe("test-chat routes", () => {
  beforeEach(async () => { await stopBoss(); await resetDb(); });
  afterEach(async () => { await stopBoss(); });

  it("requires auth", async () => {
    expect((await list(new Request("http://x/api/test-chat/conversations"))).status).toBe(401);
  });

  it("creates a test conversation, accepts a message and queues a turn", async () => {
    const created = await create(req("http://x/api/test-chat/conversations", { method: "POST", body: JSON.stringify({ language: "hi" }) }));
    expect(created.status).toBe(201);
    const c = await created.json();
    expect(c.phone).toMatch(/^\+91TEST_/);
    expect(c.phone).toMatch(/^\+91TEST_[a-z]{8}$/);
    expect(c.isTest).toBe(true);
    expect(c.language).toBe("hi");

    const sent = await send(req(`http://x/api/test-chat/conversations/${c.id}/messages`, { method: "POST", body: JSON.stringify({ content: "ghatkopar" }) }), { params: Promise.resolve({ id: c.id }) });
    expect(sent.status).toBe(202);
    expect((await (await getBoss()).findJobs(TURN_QUEUE, { key: c.id })).length).toBeGreaterThanOrEqual(1);

    const d = await detail(req(`http://x/api/test-chat/conversations/${c.id}`), { params: Promise.resolve({ id: c.id }) });
    expect((await d.json()).messages).toHaveLength(1);
    const rows = await (await list(req("http://x/api/test-chat/conversations"))).json();
    expect(rows.map((r: { id: string }) => r.id)).toEqual([c.id]);
  });

  it("rejects empty content and non-test ids", async () => {
    const created = await (await create(req("http://x/api/test-chat/conversations", { method: "POST", body: "{}" }))).json();
    const bad = await send(req(`http://x/api/test-chat/conversations/${created.id}/messages`, { method: "POST", body: JSON.stringify({ content: "  " }) }), { params: Promise.resolve({ id: created.id }) });
    expect(bad.status).toBe(400);
    const missing = await detail(req("http://x/api/test-chat/conversations/00000000-0000-0000-0000-000000000000"), { params: Promise.resolve({ id: "00000000-0000-0000-0000-000000000000" }) });
    expect(missing.status).toBe(404);
  });

  it("refuses the other routes without the admin cookie", async () => {
    const { id } = await createConversation({ isTest: true });
    const anon = (url: string, init: RequestInit = {}) => new Request(url, { ...init, headers: { "content-type": "application/json" } });
    expect((await create(anon(LIST_URL, { method: "POST", body: "{}" }))).status).toBe(401);
    expect((await detail(anon(`${LIST_URL}/${id}`), params(id))).status).toBe(401);
    expect((await send(anon(messagesUrl(id), { method: "POST", body: JSON.stringify({ content: "hi" }) }), params(id))).status).toBe(401);
    expect(await listIds()).toEqual([id]);
    expect(await getDb().select().from(messages)).toHaveLength(0);
  });

  it("creates only test conversations in agent mode, whatever else the body asks for", async () => {
    const created = await create(req(LIST_URL, { method: "POST", body: JSON.stringify({ isTest: false, phone: "+919812345678", mode: "human" }) }));
    expect(created.status).toBe(201);
    const c = await created.json();
    expect(c).toMatchObject({ isTest: true, mode: "agent", language: null });
    expect(c.phone).toMatch(/^\+91TEST_[a-z]{8}$/);
  });

  it("leaves the language unset when the one asked for is unknown or not a string", async () => {
    for (const language of ["fr", "HI", 5, ["hi"], null]) {
      const res = await create(req(LIST_URL, { method: "POST", body: JSON.stringify({ language }) }));
      expect(res.status).toBe(201);
      expect((await res.json()).language).toBeNull();
    }
  });

  it("refuses cross-site, non-JSON and oversized posts on both routes", async () => {
    const { id } = await createConversation({ isTest: true });
    const post = async (body: string, headers: Record<string, string> = {}) => [
      (await create(req(LIST_URL, { method: "POST", body, headers }))).status,
      (await send(req(messagesUrl(id), { method: "POST", body, headers }), params(id))).status,
    ];
    const hi = JSON.stringify({ content: "hi" });
    expect(await post(hi, { "sec-fetch-site": "cross-site" })).toEqual([403, 403]);
    expect(await post(hi, { "sec-fetch-site": "same-site" })).toEqual([403, 403]);
    expect(await post(hi, { "content-type": "text/plain" })).toEqual([415, 415]);
    expect(await post(JSON.stringify({ content: "x".repeat(17_000) }))).toEqual([413, 413]);
    expect(await post(hi, { "content-length": "17000" })).toEqual([413, 413]);
    expect(await listIds()).toEqual([id]);
    expect(await getDb().select().from(messages)).toHaveLength(0);
  });

  it("refuses malformed JSON, non-object and unreadable bodies with 400 on both routes", async () => {
    const { id } = await createConversation({ isTest: true });
    // duplex is what a streamed request body needs in Node; lib.dom's RequestInit does not list it.
    const post = async (body: () => BodyInit) => [
      (await create(req(LIST_URL, { method: "POST", body: body(), duplex: "half" } as RequestInit))).status,
      (await send(req(messagesUrl(id), { method: "POST", body: body(), duplex: "half" } as RequestInit), params(id))).status,
    ];
    for (const text of ["{", "", "null", "[]", '"hi"']) expect(await post(() => text)).toEqual([400, 400]);
    const unreadable = () => new ReadableStream<Uint8Array>({ pull: (controller) => controller.error(new Error("connection reset")) });
    expect(await post(unreadable)).toEqual([400, 400]);
    expect(await listIds()).toEqual([id]);
    expect(await getDb().select().from(messages)).toHaveLength(0);
  });

  it("takes 2000 characters of Indic text in a message, trimmed, and refuses the 2001st", async () => {
    const { id } = await createConversation({ isTest: true });
    const post = (content: string) =>
      send(req(messagesUrl(id), { method: "POST", body: JSON.stringify({ content }), headers: { "sec-fetch-site": "same-origin" } }), params(id));
    const over = await post("क".repeat(2001));
    expect(over.status).toBe(413);
    expect(await over.json()).toEqual({ error: "content over 2000 characters" });
    expect((await post("x".repeat(2001))).status).toBe(413);
    expect((await post("क".repeat(2000))).status).toBe(202);
    expect((await post(`  ${"x".repeat(2000)}\n`)).status).toBe(202);
    const stored = await getDb().select().from(messages);
    expect(stored.map((m) => m.content).sort()).toEqual(["क".repeat(2000), "x".repeat(2000)].sort());
  });

  it("keeps the 4 KB cap on creates", async () => {
    const res = await create(req(LIST_URL, { method: "POST", body: JSON.stringify({ language: "x".repeat(4100) }) }));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "request too large" });
    expect(await listIds()).toEqual([]);
  });

  it("answers 'stored' when the message is saved but its turn cannot be queued", async () => {
    const { id } = await createConversation({ isTest: true });
    const enqueue = vi.spyOn(boss, "enqueueTurn").mockRejectedValueOnce(Object.assign(new Error("queue down for +919812345678"), { code: "ECONNREFUSED" }));
    const logged = vi.spyOn(log, "error").mockImplementation(() => undefined);
    try {
      const res = await send(req(messagesUrl(id), { method: "POST", body: JSON.stringify({ content: "ghatkopar" }) }), params(id));
      expect(res.status).toBe(202);
      const body = await res.json();
      expect(body.status).toBe("stored");
      const stored = await getDb().select().from(messages);
      expect(stored.map((m) => [m.id, m.content])).toEqual([[body.messageId, "ghatkopar"]]);
      expect(enqueue).toHaveBeenCalledTimes(1);
      expect(logged).toHaveBeenCalledTimes(1);
      expect(logged).toHaveBeenCalledWith({ errorClass: "Error", code: "ECONNREFUSED" }, expect.any(String));
      expect(JSON.stringify(logged.mock.calls)).not.toContain("9812345678");
    } finally {
      enqueue.mockRestore();
      logged.mockRestore();
    }
  });

  it("keeps real conversations and malformed ids out of reach", async () => {
    const real = await createConversation();
    const message = (id: string) => req(messagesUrl(id), { method: "POST", body: JSON.stringify({ content: "hi" }) });
    expect((await detail(req(`${LIST_URL}/${real.id}`), params(real.id))).status).toBe(404);
    expect((await send(message(real.id), params(real.id))).status).toBe(404);
    const malformed = "-".repeat(36);
    expect((await detail(req(`${LIST_URL}/${malformed}`), params(malformed))).status).toBe(404);
    expect((await send(message("not-a-uuid"), params("not-a-uuid"))).status).toBe(404);
    expect(await listIds()).toEqual([]);
    expect(await getDb().select().from(messages)).toHaveLength(0);
    expect(await (await getBoss()).findJobs(TURN_QUEUE, { key: real.id })).toEqual([]);
  });
});
