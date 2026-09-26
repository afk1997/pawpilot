import { describe, it, expect, beforeEach } from "vitest";
import { resetDb, createConversation } from "../helpers/db";
import { GET as list } from "@/app/api/admin/conversations/route";
import { GET as detail } from "@/app/api/admin/conversations/[id]/route";
import { signAdminSession, ADMIN_COOKIE } from "@/server/admin/auth";

const authed = (url: string) => new Request(url, { headers: { cookie: `${ADMIN_COOKIE}=${signAdminSession(Date.now() + 60_000)}` } });

describe("admin routes", () => {
  beforeEach(resetDb);
  it("requires the cookie", async () => {
    expect((await list(new Request("http://x/api/admin/conversations"))).status).toBe(401);
    const c = await createConversation({ phone: "+919876500044" });
    expect((await detail(new Request(`http://x/api/admin/conversations/${c.id}`), { params: Promise.resolve({ id: c.id }) })).status).toBe(401);
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
