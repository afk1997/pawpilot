import { describe, it, expect } from "vitest";
import { readAdminJsonPost } from "@/server/admin/json-post";

/** duplex is what a streamed request body needs in Node; lib.dom's RequestInit does not list it. */
const post = (body: BodyInit, headers: Record<string, string> = {}) =>
  new Request("http://x/api/admin/thing", {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body, duplex: "half",
  } as RequestInit);
const unreadable = () => new ReadableStream<Uint8Array>({ pull: (controller) => controller.error(new Error("connection reset")) });
const statusOf = (r: Record<string, unknown> | Response) => (r instanceof Response ? r.status : "fields");

describe("readAdminJsonPost", () => {
  it("returns the fields of a JSON object body", async () => {
    expect(await readAdminJsonPost(post('{"password":"x","n":1}'))).toEqual({ password: "x", n: 1 });
  });

  it("refuses a cross-site request (403), a body not declared as JSON (415) and one over the cap (413)", async () => {
    expect(statusOf(await readAdminJsonPost(post("{}", { "sec-fetch-site": "cross-site" })))).toBe(403);
    expect(statusOf(await readAdminJsonPost(post("{}", { "content-type": "text/plain" })))).toBe(415);
    expect(statusOf(await readAdminJsonPost(post(JSON.stringify({ a: "x".repeat(5000) }))))).toBe(413);
    expect(statusOf(await readAdminJsonPost(post(JSON.stringify({ a: "x".repeat(5000) })), { maxBytes: 8 * 1024 }))).toBe("fields");
  });

  it("refuses with 400 a body that cannot be read or is not a JSON object", async () => {
    for (const body of ["not json", "", "null", "[1]", '"x"']) expect(statusOf(await readAdminJsonPost(post(body))), body).toBe(400);
    expect(statusOf(await readAdminJsonPost(post(unreadable())))).toBe(400);
  });

  it("with unusableBodyAsEmpty, reads such a body as no fields, and still refuses what comes before the read", async () => {
    const lenient = { unusableBodyAsEmpty: true };
    for (const body of ["not json", "", "null", "[1]", '"x"']) expect(await readAdminJsonPost(post(body), lenient), body).toEqual({});
    expect(await readAdminJsonPost(post(unreadable()), lenient)).toEqual({});
    expect(statusOf(await readAdminJsonPost(post("{}", { "sec-fetch-site": "same-site" }), lenient))).toBe(403);
    expect(statusOf(await readAdminJsonPost(post("{}", { "content-type": "application/x-www-form-urlencoded" }), lenient))).toBe(415);
    expect(statusOf(await readAdminJsonPost(post(JSON.stringify({ a: "x".repeat(5000) })), lenient))).toBe(413);
  });
});
