import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createConversation, resetDb } from "../helpers/db";
import { stopBoss, getBoss, TURN_QUEUE } from "@/server/queue/boss";
import { signAdminSession, ADMIN_COOKIE } from "@/server/admin/auth";
import { getDb } from "@/server/db/client";
import { messages } from "@/server/db/schema";
import { GET as list, POST as create } from "@/app/api/test-chat/conversations/route";
import { GET as detail } from "@/app/api/test-chat/conversations/[id]/route";
import { POST as send } from "@/app/api/test-chat/conversations/[id]/messages/route";

const cookie = () => ({ cookie: `${ADMIN_COOKIE}=${signAdminSession(Date.now() + 60_000)}` });
const req = (url: string, init: RequestInit = {}) => new Request(url, { ...init, headers: { "content-type": "application/json", ...cookie(), ...(init.headers ?? {}) } });
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const listIds = async () => (await (await list(req("http://x/api/test-chat/conversations"))).json()).map((r: { id: string }) => r.id);

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
    expect((await create(anon("http://x/api/test-chat/conversations", { method: "POST", body: "{}" }))).status).toBe(401);
    expect((await detail(anon(`http://x/api/test-chat/conversations/${id}`), params(id))).status).toBe(401);
    const message = anon(`http://x/api/test-chat/conversations/${id}/messages`, { method: "POST", body: JSON.stringify({ content: "hi" }) });
    expect((await send(message, params(id))).status).toBe(401);
    expect(await listIds()).toEqual([id]);
    expect(await getDb().select().from(messages)).toHaveLength(0);
  });

  it("refuses cross-site, non-JSON and oversized posts on both routes", async () => {
    const { id } = await createConversation({ isTest: true });
    const post = async (body: string, headers: Record<string, string> = {}) => [
      (await create(req("http://x/api/test-chat/conversations", { method: "POST", body, headers }))).status,
      (await send(req(`http://x/api/test-chat/conversations/${id}/messages`, { method: "POST", body, headers }), params(id))).status,
    ];
    const hi = JSON.stringify({ content: "hi" });
    expect(await post(hi, { "sec-fetch-site": "cross-site" })).toEqual([403, 403]);
    expect(await post(hi, { "sec-fetch-site": "same-site" })).toEqual([403, 403]);
    expect(await post(hi, { "content-type": "text/plain" })).toEqual([415, 415]);
    expect(await post(JSON.stringify({ content: "x".repeat(5000) }))).toEqual([413, 413]);
    expect(await post(hi, { "content-length": "5000" })).toEqual([413, 413]);
    expect(await listIds()).toEqual([id]);
    expect(await getDb().select().from(messages)).toHaveLength(0);
  });

  it("trims content and caps it at 2000 characters", async () => {
    const { id } = await createConversation({ isTest: true });
    const post = (content: string) =>
      send(req(`http://x/api/test-chat/conversations/${id}/messages`, { method: "POST", body: JSON.stringify({ content }), headers: { "sec-fetch-site": "same-origin" } }), params(id));
    expect((await post("x".repeat(2001))).status).toBe(413);
    expect((await post(`  ${"x".repeat(2000)}\n`)).status).toBe(202);
    const stored = await getDb().select().from(messages);
    expect(stored.map((m) => m.content)).toEqual(["x".repeat(2000)]);
  });

  it("keeps real conversations and malformed ids out of reach", async () => {
    const real = await createConversation();
    const message = (id: string) => req(`http://x/api/test-chat/conversations/${id}/messages`, { method: "POST", body: JSON.stringify({ content: "hi" }) });
    expect((await detail(req(`http://x/api/test-chat/conversations/${real.id}`), params(real.id))).status).toBe(404);
    expect((await send(message(real.id), params(real.id))).status).toBe(404);
    const malformed = "-".repeat(36);
    expect((await detail(req(`http://x/api/test-chat/conversations/${malformed}`), params(malformed))).status).toBe(404);
    expect((await send(message("not-a-uuid"), params("not-a-uuid"))).status).toBe(404);
    expect(await listIds()).toEqual([]);
    expect(await getDb().select().from(messages)).toHaveLength(0);
  });
});
