import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { asc, eq } from "drizzle-orm";
import { resetDb, createConversation } from "../helpers/db";
import { seedDirectory, type DirectoryIds } from "../helpers/fixtures";
import { getDb } from "@/server/db/client";
import { ambulances, conversations, events, messages, turns } from "@/server/db/schema";
import { storeReporterMessage } from "@/server/inbound/store";
import { runTurn } from "@/server/worker/turn-runner";
import { getBoss, stopBoss, TURN_QUEUE } from "@/server/queue/boss";
import { FakeBackend, okReply } from "@/server/agent/fake-backend";
import { makeHandle } from "@/server/agent/handles";
import { findDigitRuns } from "@/server/agent/scrub";
import { resetConfigForTests } from "@/server/config";
import { setFetchForTests } from "@/server/interakt/client";
import * as repo from "@/server/directory/repo";
import * as deliver from "@/server/worker/deliver";
import { createTurn } from "@/server/worker/persist";
import { log } from "@/server/log";
import { welcomeText } from "@/server/messages/welcome";
import type { Language } from "@/server/types";

let ids: DirectoryIds;
const conv = (opts: { language?: Language | null; welcomed?: boolean } = {}) =>
  createConversation({
    isTest: true, phone: `+91TEST_${Math.random().toString(36).slice(2, 9)}`, language: opts.language ?? null,
    welcomedAt: opts.welcomed === false ? null : new Date(),
  });
const outbound = async (id: string) =>
  (await getDb().select().from(messages).where(eq(messages.conversationId, id)).orderBy(asc(messages.createdAt))).filter((m) => m.role === "assistant");
const turnOf = async (id: string) => (await getDb().select().from(turns).where(eq(turns.id, id)))[0];
const conversationRow = async (id: string) => (await getDb().select().from(conversations).where(eq(conversations.id, id)))[0];
const eventsOf = async (kind: string) => getDb().select().from(events).where(eq(events.kind, kind));
/** A backend that must never be reached: the fast path answers without it. */
const untouched = () => new FakeBackend([okReply({ reply: "the model was called", intent: "other" })]);

const GHATKOPAR_EN = "Here is the animal ambulance for your area:\n\nArham Animal Ambulance, Ghatkopar\n+91 70000 00001\nPlease call them right away.";
/** A conversation with no reply yet is at first contact, whatever its welcome claim says: its card opens with this. */
const GREETING_EN = "Namaste! 🙏 ";

describe("the fast path", () => {
  beforeEach(async () => { await stopBoss(); await resetDb(); ids = await seedDirectory(); });
  afterEach(async () => {
    vi.restoreAllMocks();
    setFetchForTests(null);
    vi.unstubAllEnvs();
    resetConfigForTests();
    await stopBoss();
  });

  it("answers a first burst naming one unit's area with its card, without the model, and audits the turn", async () => {
    const c = await conv();
    const sent = await storeReporterMessage(c.id, { kind: "text", content: "ghatkopar me kutta ghayal hai" });
    const backend = untouched();
    const r = await runTurn(c.id, { backend });
    expect(r).toMatchObject({ kind: "fast_path", requeued: false });
    expect(backend.calls).toHaveLength(0);

    const handle = makeHandle("ambulance", c.id, ids.ghatkopar);
    const template = `${GREETING_EN}Here is the animal ambulance for your area:\n\nArham Animal Ambulance, Ghatkopar\n{{AMB:${handle}}}\nPlease call them right away.`;
    const out = await outbound(c.id);
    expect(out.map((m) => [m.origin, m.kind, m.turnId, m.deliveryStatus, m.content, m.contentTemplate])).toEqual([
      ["system", "text", r.turnId, "test_skipped", `${GREETING_EN}${GHATKOPAR_EN}`, template],
    ]);
    expect(template).not.toMatch(/\d/);

    const t = await turnOf(r.turnId!);
    expect(t).toMatchObject({ status: "ok", model: "fast_path", error: null, handles: { [handle]: { kind: "ambulance", id: ids.ghatkopar } } });
    expect(t.structuredOutput).toEqual({
      reply: template, language: "en", intent: "ambulance", location: { city: "Mumbai", area: "Ghatkopar" }, needs_human: false,
      notes: "fast path: exact single-unit match", matched: 1, matchType: "area", sent: "unit", fastPath: true,
    });
    expect(t.latencyMs).toEqual(expect.any(Number));
    expect(t.usage).toBeNull();

    const [inbound] = await getDb().select().from(messages).where(eq(messages.id, sent.id!));
    expect(inbound.answeredTurnId).toBe(r.turnId);
    const row = await conversationRow(c.id);
    expect([row.flagged, row.flagReason, row.language]).toEqual([false, null, "en"]);
    expect((await eventsOf("fast_path")).map((e) => [e.conversationId, e.payload])).toEqual([
      [c.id, { turnId: r.turnId, matchType: "area", unitLabel: "Mumbai - Ghatkopar" }],
    ]);
  });

  it("answers in the reporter's language and script, and stores that language", async () => {
    const c = await conv();
    await storeReporterMessage(c.id, { kind: "text", content: "घाटकोपर में कुत्ता घायल है" });
    const r = await runTurn(c.id, { backend: untouched() });
    expect(r.kind).toBe("fast_path");
    const [m] = await outbound(c.id);
    expect(m.content).toBe("नमस्ते! 🙏 आपके इलाके की एनिमल एम्बुलेंस यह रही:\n\nArham Animal Ambulance, Ghatkopar\n+91 70000 00001\nकृपया उन्हें तुरंत कॉल करें।");
    expect((await turnOf(r.turnId!)).structuredOutput).toMatchObject({ language: "hi", intent: "ambulance" });
    expect((await conversationRow(c.id)).language).toBe("hi");
  });

  it("keeps a language the conversation already has", async () => {
    const c = await conv({ language: "gu" });
    await storeReporterMessage(c.id, { kind: "text", content: "Ghatkopar" });
    const r = await runTurn(c.id, { backend: untouched() });
    expect(r.kind).toBe("fast_path");
    expect((await outbound(c.id))[0].content).toContain("કૃપા કરીને તેમને તરત જ કૉલ કરો.");
    expect((await conversationRow(c.id)).language).toBe("gu");
  });

  it("answers a city match whose city has one unit", async () => {
    const [unit] = await getDb()
      .insert(ambulances)
      .values({ operatorId: ids.arhamOperatorId, label: "Nagpur", city: "Nagpur", area: null, state: "Maharashtra", phone: "+919876500077", areasCovered: [] })
      .returning();
    const c = await conv();
    await storeReporterMessage(c.id, { kind: "text", content: "Nagpur, injured cow" });
    const r = await runTurn(c.id, { backend: untouched() });
    expect(r.kind).toBe("fast_path");
    expect((await outbound(c.id))[0].content).toBe(`${GREETING_EN}Here is the animal ambulance for your area:\n\nArham Animal Ambulance, Nagpur\n+91 98765 00077\nPlease call them right away.`);
    const t = await turnOf(r.turnId!);
    expect(t.structuredOutput).toMatchObject({ matchType: "city", location: { city: "Nagpur", area: null } });
    expect(t.handles).toEqual({ [makeHandle("ambulance", c.id, unit.id)]: { kind: "ambulance", id: unit.id } });
  });

  it("masks a phone-shaped run in a unit's directory cells in the stored template, keeping the token whole", async () => {
    const [unit] = await getDb()
      .insert(ambulances)
      .values({
        operatorId: ids.arhamOperatorId, label: "Nagpur - Sitabuldi", city: "Nagpur", area: "Sitabuldi 98765 00123", state: "Maharashtra",
        phone: "+919876500078", areasCovered: ["Sitabuldi"],
      })
      .returning();
    const c = await conv();
    await storeReporterMessage(c.id, { kind: "text", content: "Sitabuldi, Nagpur" });
    const r = await runTurn(c.id, { backend: untouched() });
    expect(r.kind).toBe("fast_path");
    const [m] = await outbound(c.id);
    // What the reporter gets is the directory as it stands.
    expect(m.content).toContain("Arham Animal Ambulance, Sitabuldi 98765 00123\n+91 98765 00078\n");
    const token = `{{AMB:${makeHandle("ambulance", c.id, unit.id)}}}`;
    expect(m.contentTemplate).toContain(`Arham Animal Ambulance, Sitabuldi [number sent]\n${token}\nPlease call them right away.`);
    expect(findDigitRuns(m.contentTemplate!)).toEqual([]);
    expect((await turnOf(r.turnId!)).structuredOutput).toMatchObject({ reply: m.contentTemplate });
  });

  it("answers a labelled location pin, recording the unit's city, and its area only when the reporter named it", async () => {
    const c = await conv();
    await storeReporterMessage(c.id, { kind: "location", content: "Karve Nagar, Pune", placeLabel: "Karve Nagar, Pune", lat: 18.5, lng: 73.8 });
    const r = await runTurn(c.id, { backend: untouched() });
    expect(r.kind).toBe("fast_path");
    expect((await outbound(c.id))[0].content).toContain("Arham Animal Ambulance, PMC\n+91 98765 00005");
    // PMC is the unit's area, not the reporter's: the place known from here on is Pune.
    expect((await turnOf(r.turnId!)).structuredOutput).toMatchObject({ location: { city: "Pune", area: null } });
    await storeReporterMessage(c.id, { kind: "text", content: "thanks" });
    const backend = new FakeBackend([okReply({ reply: "You're welcome.", intent: "smalltalk" })]);
    expect((await runTurn(c.id, { backend })).kind).toBe("ok");
    expect(backend.calls[0].prompt).toContain("Location known so far: Pune\n");
  });

  it.each([
    ["another intent in the burst", [{ kind: "text", content: "ghatkopar clinic ka number do" }], "other_intent"],
    ["a city with more than one unit", [{ kind: "text", content: "Mumbai" }], "no_single_match"],
    ["a place matched only loosely", [{ kind: "text", content: "Ghatkoparr" }], "no_single_match"],
    ["a unit's area with another city named", [{ kind: "text", content: "Ghatkopar, Pune me kutta ghayal hai" }], "other_city"],
    ["an area name with a generic locality word and no city", [{ kind: "text", content: "Karve Nagar me kutta ghayal hai" }], "generic_area"],
    ["a photo in the burst", [{ kind: "image", content: "ghatkopar", mediaUrl: "https://x/p.jpg" }], "burst"],
    ["a pin without a place label", [{ kind: "location", content: "", placeLabel: null, lat: 19.08, lng: 72.9 }], "burst"],
    ["a text over 300 characters", [{ kind: "text", content: `ghatkopar me kutta ghayal hai. ${"bahut khoon nikal raha hai, jaldi madad chahiye. ".repeat(6)}` }], "too_long"],
  ] as const)("leaves %s to the model, logging why", async (_case, burst, reason) => {
    const debug = vi.spyOn(log, "debug").mockImplementation(() => undefined);
    const c = await conv();
    for (const m of burst) await storeReporterMessage(c.id, m);
    const backend = new FakeBackend([okReply({ reply: "Which area are you in?", intent: "ambulance" })]);
    const r = await runTurn(c.id, { backend });
    expect(r.kind).toBe("ok");
    expect(backend.calls).toHaveLength(1);
    expect(await eventsOf("fast_path")).toEqual([]);
    expect(debug).toHaveBeenCalledWith({ conversationId: c.id, reason }, "fast path did not fire");
  });

  it("leaves every burst after the first answered one to the model: after the model's reply, or a fast path's", async () => {
    const afterModel = await conv();
    await storeReporterMessage(afterModel.id, { kind: "text", content: "hello, need help" });
    const backend = new FakeBackend([okReply({ reply: "Which area are you in?", intent: "ambulance" }), okReply({ reply: "Noted.", intent: "ambulance" })]);
    expect((await runTurn(afterModel.id, { backend })).kind).toBe("ok");
    await storeReporterMessage(afterModel.id, { kind: "text", content: "ghatkopar" });
    expect((await runTurn(afterModel.id, { backend })).kind).toBe("ok");
    expect(backend.calls).toHaveLength(2);

    const afterFast = await conv();
    await storeReporterMessage(afterFast.id, { kind: "text", content: "ghatkopar" });
    expect((await runTurn(afterFast.id, { backend: untouched() })).kind).toBe("fast_path");
    await storeReporterMessage(afterFast.id, { kind: "text", content: "ghatkopar" });
    const next = new FakeBackend([okReply({ reply: "Please call the number above.", intent: "ambulance" })]);
    expect((await runTurn(afterFast.id, { backend: next })).kind).toBe("ok");
    expect(next.calls).toHaveLength(1);
  });

  it("counts only a reply that answered the reporter: the fallback's or a person's, never the welcome, the voice-note line or a system row", async () => {
    const debug = vi.spyOn(log, "debug").mockImplementation(() => undefined);
    const withReply = async (origin: "fallback" | "human" | "system", turnModel: string | null) => {
      const c = await conv();
      const turn = turnModel === null ? null : await createTurn({ conversationId: c.id, status: "ok", model: turnModel });
      await getDb().insert(messages).values({ conversationId: c.id, role: "assistant", origin, content: "an earlier reply", turnId: turn?.id ?? null });
      await storeReporterMessage(c.id, { kind: "text", content: "ghatkopar me kutta ghayal hai" });
      return c;
    };
    // The no-LLM fallback's reply and a person's (no turn) answered the reporter: the model reads the next burst.
    for (const c of [await withReply("fallback", "fallback"), await withReply("human", null), await withReply("fallback", null)]) {
      const backend = new FakeBackend([okReply({ reply: "Please call the number above.", intent: "ambulance" })]);
      expect((await runTurn(c.id, { backend })).kind).toBe("ok");
      expect(backend.calls).toHaveLength(1);
      expect(debug).toHaveBeenCalledWith({ conversationId: c.id, reason: "answered_before" }, "fast path did not fire");
    }
    // A system row with no turn, or the welcome's, answered nothing: the fast path still fires, with no greeting.
    for (const c of [await withReply("system", null), await withReply("system", "system:welcome")]) {
      expect((await runTurn(c.id, { backend: untouched() })).kind).toBe("fast_path");
      expect((await outbound(c.id)).at(-1)!.content).toBe(GHATKOPAR_EN);
    }
    // The voice-note line, sent for real.
    const voice = await conv();
    await storeReporterMessage(voice.id, { kind: "audio", content: "", mediaUrl: "https://x/a.ogg" });
    expect((await runTurn(voice.id)).kind).toBe("audio_only");
    await storeReporterMessage(voice.id, { kind: "text", content: "ghatkopar me kutta ghayal hai" });
    expect((await runTurn(voice.id, { backend: untouched() })).kind).toBe("fast_path");
    expect((await outbound(voice.id)).at(-1)!.content).toBe(GHATKOPAR_EN);
  });

  it("gives a partner unit's card with its operator named, and its template the token alone", async () => {
    const [unit] = await getDb()
      .insert(ambulances)
      .values({ operatorId: ids.blueCrossOperatorId, label: "Jamnagar - Blue Cross", city: "Jamnagar", area: null, state: "Gujarat", phone: "+919876500079", areasCovered: ["Jamnagar"] })
      .returning();
    const c = await conv({ language: "hi" });
    await storeReporterMessage(c.id, { kind: "text", content: "जामनगर में गाय घायल है" });
    const r = await runTurn(c.id, { backend: untouched() });
    expect(r.kind).toBe("fast_path");
    const [m] = await outbound(c.id);
    expect(m.content).toBe("नमस्ते! 🙏 आपके इलाके की एनिमल एम्बुलेंस यह रही:\n\nAnimal Ambulance, Jamnagar\n+91 98765 00079\n(Blue Cross द्वारा संचालित)\nकृपया उन्हें तुरंत कॉल करें।");
    // The token renders the number with the operator's label (renderNumberForToken), so the template has no line for it.
    const token = `{{AMB:${makeHandle("ambulance", c.id, unit.id)}}}`;
    expect(m.contentTemplate).toBe(`नमस्ते! 🙏 आपके इलाके की एनिमल एम्बुलेंस यह रही:\n\nAnimal Ambulance, Jamnagar\n${token}\nकृपया उन्हें तुरंत कॉल करें।`);
    expect((await turnOf(r.turnId!)).structuredOutput).toMatchObject({ location: { city: "Jamnagar", area: null }, matchType: "area" });
  });

  it("is off when FAST_PATH_ENABLED is false", async () => {
    vi.stubEnv("FAST_PATH_ENABLED", "false");
    resetConfigForTests();
    const c = await conv();
    await storeReporterMessage(c.id, { kind: "text", content: "ghatkopar me kutta ghayal hai" });
    const backend = new FakeBackend([okReply({ reply: "Please call {{PHONE:helpline}}.", intent: "ambulance" })]);
    expect((await runTurn(c.id, { backend })).kind).toBe("ok");
    expect(backend.calls).toHaveLength(1);
  });

  it("gives the next model turn the token, never the number, with the handle listed as shared and the place as known", async () => {
    const c = await conv();
    await storeReporterMessage(c.id, { kind: "text", content: "ghatkopar me kutta ghayal hai" });
    expect((await runTurn(c.id)).kind).toBe("fast_path");
    await storeReporterMessage(c.id, { kind: "text", content: "driver ne phone nahi uthaya" });
    const backend = new FakeBackend([okReply({ reply: "Please call {{PHONE:helpline}}.", intent: "ambulance", needs_human: true })]);
    expect((await runTurn(c.id, { backend })).kind).toBe("ok");
    const handle = makeHandle("ambulance", c.id, ids.ghatkopar);
    const prompt = backend.calls[0].prompt;
    expect(prompt).toMatch(/\] System: Namaste! 🙏 Here is the animal ambulance for your area:\n {2}\n {2}Arham Animal Ambulance, Ghatkopar\n {2}\{\{AMB:amb_[a-p]{8}\}\}\n {2}Please call them right away\./);
    expect(prompt).toContain(`{{AMB:${handle}}}`);
    expect(prompt).toContain(`Handles already shared in this chat: ${handle}`);
    expect(prompt).toContain("Location known so far: Ghatkopar, Mumbai");
    expect(prompt).not.toContain("70000");
    expect(findDigitRuns(prompt)).toEqual([]);
  });

  it("sends the card alone on first contact, greeting first; a welcome sent for a bare greeting does not count as an answer", async () => {
    const c = await conv({ welcomed: false });
    await storeReporterMessage(c.id, { kind: "text", content: "ghatkopar me kutta ghayal hai" });
    const r = await runTurn(c.id, { backend: untouched() });
    expect(r.kind).toBe("fast_path");
    const out = await outbound(c.id);
    expect(out.map((m) => [m.kind, m.content])).toEqual([["text", `Namaste! 🙏 ${GHATKOPAR_EN}`]]);
    expect(out[0].contentTemplate).toMatch(/^Namaste! 🙏 Here is the animal ambulance for your area:\n\n/);
    expect(out[0].contentTemplate).not.toMatch(/\d/);
    expect((await conversationRow(c.id)).welcomedAt).not.toBeNull();

    const greeted = await conv({ welcomed: false });
    await storeReporterMessage(greeted.id, { kind: "text", content: "hi" });
    expect((await runTurn(greeted.id)).kind).toBe("welcome");
    await storeReporterMessage(greeted.id, { kind: "text", content: "ghatkopar" });
    expect((await runTurn(greeted.id, { backend: untouched() })).kind).toBe("fast_path");
    expect((await outbound(greeted.id)).map((m) => [m.kind, m.content])).toEqual([["interactive", welcomeText("en")], ["text", GHATKOPAR_EN]]);
  });

  it("still greets when a first burst is retried after a failure before its card was written", async () => {
    const c = await conv({ welcomed: false });
    const sent = await storeReporterMessage(c.id, { kind: "text", content: "ghatkopar me kutta ghayal hai" });
    vi.spyOn(deliver, "deliverText").mockRejectedValueOnce(new Error("write-ahead failed"));
    await expect(runTurn(c.id, { backend: untouched() })).rejects.toThrow("write-ahead failed");
    // Nothing was written: the burst is still pending, and the welcome claim is taken.
    expect(await outbound(c.id)).toEqual([]);
    expect((await getDb().select().from(messages).where(eq(messages.id, sent.id!)))[0].answeredTurnId).toBeNull();
    expect((await conversationRow(c.id)).welcomedAt).not.toBeNull();
    // The job's retry: still the reporter's first contact, so the card still opens with the greeting.
    const r = await runTurn(c.id, { backend: untouched() });
    expect(r.kind).toBe("fast_path");
    expect((await outbound(c.id)).map((m) => m.content)).toEqual([`${GREETING_EN}${GHATKOPAR_EN}`]);
  });

  it("marks the turn failed with delivery_failed when the card was not delivered, keeping the burst answered", async () => {
    setFetchForTests((async () => new Response(JSON.stringify({ message: "rejected" }), { status: 400 })) as typeof fetch);
    const c = await createConversation({ phone: "+919876500981", welcomedAt: new Date() });
    const sent = await storeReporterMessage(c.id, { kind: "text", content: "ghatkopar" });
    const r = await runTurn(c.id, { backend: untouched() });
    expect(r.kind).toBe("fast_path");
    const t = await turnOf(r.turnId!);
    expect([t.status, t.error, t.model]).toEqual(["failed", "delivery_failed", "fast_path"]);
    const [inbound] = await getDb().select().from(messages).where(eq(messages.id, sent.id!));
    expect(inbound.answeredTurnId).toBe(r.turnId);
    const row = await conversationRow(c.id);
    expect([row.flagged, row.flagReason]).toEqual([true, "send_failed"]);
  });

  it("requeues at once for a message that arrives while the card is being sent", async () => {
    const c = await createConversation({ phone: "+919876500982", welcomedAt: new Date() });
    await storeReporterMessage(c.id, { kind: "text", content: "ghatkopar" });
    let ran = false;
    setFetchForTests((async () => {
      if (!ran) {
        ran = true;
        await storeReporterMessage(c.id, { kind: "text", content: "and a cat too" });
      }
      return new Response(JSON.stringify({ id: "wa-fast" }), { status: 201 });
    }) as typeof fetch);
    const r = await runTurn(c.id, { backend: untouched() });
    expect(r).toMatchObject({ kind: "fast_path", requeued: true });
    expect(await (await getBoss()).findJobs(TURN_QUEUE, { key: c.id })).toHaveLength(1);
  });

  it("goes to the model, visibly, when the fast path's own lookup fails", async () => {
    vi.spyOn(repo, "loadActiveAmbulances").mockRejectedValueOnce(Object.assign(new Error("pool exhausted for +919876543210"), { code: "53300" }));
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const c = await conv();
    await storeReporterMessage(c.id, { kind: "text", content: "ghatkopar" });
    const backend = new FakeBackend([okReply({ reply: "Please call {{PHONE:helpline}}.", intent: "ambulance" })]);
    expect((await runTurn(c.id, { backend })).kind).toBe("ok");
    expect(backend.calls).toHaveLength(1);
    expect((await eventsOf("fast_path_error")).map((e) => e.payload)).toEqual([{ errorClass: "Error", code: "53300" }]);
    expect(warn).toHaveBeenCalledWith({ conversationId: c.id, errorClass: "Error", code: "53300" }, "fast path check failed; the model answers");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("9876543210");
  });
});
