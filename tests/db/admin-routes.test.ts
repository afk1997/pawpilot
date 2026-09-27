import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetDb, createConversation } from "../helpers/db";
import { GET as list } from "@/app/api/admin/conversations/route";
import { GET as detail } from "@/app/api/admin/conversations/[id]/route";
import { signAdminSession, ADMIN_COOKIE } from "@/server/admin/auth";
import * as queries from "@/server/admin/queries";
import { log } from "@/server/log";

const authed = (url: string) => new Request(url, { headers: { cookie: `${ADMIN_COOKIE}=${signAdminSession(Date.now() + 60_000)}` } });

describe("admin routes", () => {
  beforeEach(resetDb);
  afterEach(() => vi.restoreAllMocks());
  it("requires the cookie", async () => {
    expect((await list(new Request("http://x/api/admin/conversations"))).status).toBe(401);
    const c = await createConversation({ phone: "+919876500044" });
    const anonymous = (id: string) => detail(new Request(`http://x/api/admin/conversations/${id}`), { params: Promise.resolve({ id }) });
    expect((await anonymous(c.id)).status).toBe(401);
    // The cookie is checked first: a malformed or unknown id does not get a different answer.
    expect((await anonymous("not-a-uuid")).status).toBe(401);
    expect((await anonymous("00000000-0000-0000-0000-000000000000")).status).toBe(401);
  });
  it("answers 503 and logs only the error's class and code when a query fails", async () => {
    // A failed query's message quotes its parameters: here the phone that was searched for.
    const failure = () =>
      Object.assign(new Error("Failed query: select … params: %+919876500033%"), { cause: Object.assign(new Error("terminating connection"), { code: "57P01" }) });
    vi.spyOn(queries, "listConversations").mockRejectedValueOnce(failure());
    vi.spyOn(queries, "getConversationDetail").mockRejectedValueOnce(failure());
    const logs = (["error", "warn", "info", "debug"] as const).map((level) => vi.spyOn(log, level).mockImplementation(() => undefined));
    const id = "00000000-0000-0000-0000-000000000000";
    const answers = [
      await list(authed("http://x/api/admin/conversations?filter=all&q=%2B919876500033")),
      await detail(authed(`http://x/api/admin/conversations/${id}`), { params: Promise.resolve({ id }) }),
    ];
    for (const res of answers) {
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "unavailable" });
    }
    const line = [{ errorClass: "Error", code: "57P01" }, "admin conversations query failed"];
    expect(logs[0].mock.calls).toEqual([line, line]);
    expect(JSON.stringify(logs.map((spy) => spy.mock.calls))).not.toMatch(/9876500033/);
  });
  it("lists and fetches detail when authenticated", async () => {
    const c = await createConversation({ phone: "+919876500033" });
    const res = await list(authed("http://x/api/admin/conversations?filter=all&q=0033"));
    expect(res.status).toBe(200);
    expect((await res.json()).map((r: { id: string }) => r.id)).toEqual([c.id]);
    const d = await detail(authed(`http://x/api/admin/conversations/${c.id}`), { params: Promise.resolve({ id: c.id }) });
    expect(d.status).toBe(200);
    expect((await d.json()).conversation.id).toBe(c.id);
    const missing = await detail(authed("http://x/api/admin/conversations/00000000-0000-0000-0000-000000000000"), { params: Promise.resolve({ id: "00000000-0000-0000-0000-000000000000" }) });
    expect(missing.status).toBe(404);
    // Not a UUID: refused before the query, which Postgres would reject with an error.
    const malformed = await detail(authed("http://x/api/admin/conversations/not-a-uuid"), { params: Promise.resolve({ id: "not-a-uuid" }) });
    expect(malformed.status).toBe(404);
  });
});
