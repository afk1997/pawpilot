import { describe, it, expect, afterEach, vi } from "vitest";
import { HandleRegistry, makeHandle } from "@/server/agent/handles";
import { prematchAmbulances, type ToolContext } from "@/server/agent/tools";
import type { DirectoryAmbulance } from "@/server/directory/matcher";
import * as repo from "@/server/directory/repo";

/** A directory-like unit with a dummy phone. */
const unit = (id: string, city: string, area: string | null, areasCovered: string[]): DirectoryAmbulance => ({
  id, label: id, city, area, state: "X", areasCovered, category: "Animal Ambulance", phone: "+910000000000",
  operatorName: "Arham Yuva Seva Group", operatorIsArham: true,
});

const rows: DirectoryAmbulance[] = [
  unit("ghatkopar", "Mumbai", "Ghatkopar", ["Ghatkopar", "Vikhroli"]),
  unit("malad", "Mumbai", "Malad", ["Malad", "Kandivali"]),
  unit("pmc", "Pune", "PMC", ["Kothrud", "Karve Nagar"]),
  unit("pcmc", "Pune", "PCMC", ["Pimpri", "Chinchwad"]),
  unit("ahmedabad", "Ahmedabad", null, ["Satellite", "Ghuma"]),
  unit("delhi", "Delhi", "Old Delhi", ["Model Town", "Shalimar Bagh"]),
  unit("surat", "Surat", null, ["Surat", "Vesu"]),
];

const CONV = "conversation-unit";
const context = (): ToolContext => ({
  conversationId: CONV, language: "en", registry: new HandleRegistry(CONV), calls: [], lastAmbulanceCandidates: null, lastAmbulanceMatch: null,
});
const prematch = async (query: string, knownLocation: { city: string | null; area: string | null } | null = null) => {
  vi.spyOn(repo, "loadActiveAmbulances").mockResolvedValue(rows);
  const ctx = context();
  const r = await prematchAmbulances(ctx, { query, knownLocation });
  return { ...r, ctx };
};

describe("prematchAmbulances and the fast path's precision rules", () => {
  afterEach(() => vi.restoreAllMocks());

  it("still pre-matches a unit's own area named alone (ghatkopar), arming the card", async () => {
    const { prematched, record, ctx } = await prematch("ghatkopar");
    const handle = makeHandle("ambulance", CONV, "ghatkopar");
    expect(prematched).toEqual({
      matchType: "area", source: "words",
      units: [{ handle, display_name: "Arham Animal Ambulance, Ghatkopar", city: "Mumbai", area: "Ghatkopar", operator_name: "Arham Yuva Seva Group", operator_is_arham: true, hours: null, covers: null }],
    });
    expect([ctx.lastAmbulanceCandidates?.map((u) => u.id), ctx.lastAmbulanceMatch]).toEqual([["ghatkopar"], "area"]);
    expect(record.output).toEqual({ matchType: "area", count: 1, handles: [handle] });
  });

  it("hands the model a unit's published hours, scrubbed as tool output is (every dash a hyphen)", async () => {
    vi.spyOn(repo, "loadActiveAmbulances").mockResolvedValue([{ ...rows[0], hours: "10am–7pm IST" }, ...rows.slice(1)]);
    const ctx = context();
    const { prematched } = await prematchAmbulances(ctx, { query: "ghatkopar", knownLocation: null });
    expect(prematched?.units.map((u) => u.hours)).toEqual(["10am-7pm IST"]);
    // The card the pre-match arms is built from the directory's row, so it shows the hours as written.
    expect(ctx.lastAmbulanceCandidates?.map((u) => u.hours)).toEqual(["10am–7pm IST"]);
  });

  it("still pre-matches a generic area name when the words name the unit's city (Karve Nagar, Pune)", async () => {
    const { prematched, record, ctx } = await prematch("Karve Nagar, Pune");
    const handle = makeHandle("ambulance", CONV, "pmc");
    expect(prematched).toMatchObject({ matchType: "area", source: "words", units: [{ handle, display_name: "Arham Animal Ambulance, PMC", covers: "Karve Nagar" }] });
    expect(ctx.lastAmbulanceMatch).toBe("area");
    expect(record.output).toEqual({ matchType: "area", count: 1, handles: [handle] });
  });

  it.each([
    ["Mumbai me gaadi ghuma rahe the, kutta ghayal ho gaya", "other_city"],
    ["Ghatkopar, Pune", "other_city"],
    ["Model Town me kutta ghayal hai", "generic_area"],
    ["Model Town, Ludhiana", "generic_area"],
    ["kutte ki surat pe chot hai", "everyday_city"],
    ["कुत्ते की सूरत पर चोट है", "everyday_city"],
    ["kutte ki surat se khoon aa raha hai", "everyday_city"],
    ["is surat me kya karein", "everyday_city"],
    // A request for a hospital, a clinic or a doctor wants the facility, not the area's ambulance.
    ["ghatkopar hospital ka number", "other_intent"],
    ["Ghatkopar ke doctor ka number do", "other_intent"],
    ["घाटकोपर में कोई दवाखाना है?", "other_intent"],
  ])("pre-matches nothing for %s (%s): no block, no handle, no armed card", async (query, skipped) => {
    const { prematched, record, ctx } = await prematch(query);
    expect(prematched).toBeNull();
    expect([ctx.lastAmbulanceCandidates, ctx.lastAmbulanceMatch]).toEqual([null, null]);
    expect(ctx.registry.toJSON()).toEqual({});
    expect(record).toEqual({ name: "prematch", input: { query }, output: { matchType: "area", count: 1, handles: [], skipped }, durationMs: expect.any(Number) });
  });

  it("pre-matches Model Town when the words name Delhi", async () => {
    const { prematched } = await prematch("Model Town, Delhi, dog injured");
    expect(prematched).toMatchObject({ source: "words", units: [{ display_name: "Arham Animal Ambulance, Old Delhi", covers: "Model Town" }] });
  });

  it("holds the words to the city the conversation knows: another city's unit is not pre-matched unless named", async () => {
    const skippedRun = await prematch("gaadi ghuma rahe the tab dekha", { city: "Mumbai", area: null });
    expect(skippedRun.prematched).toBeNull();
    expect([skippedRun.ctx.lastAmbulanceCandidates, skippedRun.ctx.lastAmbulanceMatch]).toEqual([null, null]);
    expect(skippedRun.record.output).toEqual({ matchType: "area", count: 1, handles: [], skipped: "other_city" });
    // A generic area name in the city the conversation knows is precise.
    const known = await prematch("Karve Nagar me", { city: "Pune", area: null });
    expect(known.prematched).toMatchObject({ source: "words", units: [{ display_name: "Arham Animal Ambulance, PMC", covers: "Karve Nagar" }] });
    expect(known.ctx.lastAmbulanceMatch).toBe("area");
  });

  it("offers no ambulance for a facility request, not even the known location's, and still pre-matches an ambulance request", async () => {
    const facility = await prematch("hospital ka number?", { city: "Mumbai", area: "Ghatkopar" });
    expect(facility.prematched).toBeNull();
    expect([facility.ctx.lastAmbulanceCandidates, facility.ctx.lastAmbulanceMatch]).toEqual([null, null]);
    expect(facility.ctx.registry.toJSON()).toEqual({});
    // The known location was not looked up: the record holds the words' own lookup.
    expect(facility.record).toEqual({
      name: "prematch", input: { query: "hospital ka number?" }, output: { matchType: null, count: 0, handles: [], skipped: "other_intent" }, durationMs: expect.any(Number),
    });
    const ambulance = await prematch("ghatkopar me kutta ghayal hai");
    expect(ambulance.prematched).toMatchObject({ matchType: "area", source: "words", units: [{ display_name: "Arham Animal Ambulance, Ghatkopar" }] });
    expect(ambulance.record.output).not.toHaveProperty("skipped");
  });

  it("pre-matches a city that is also an everyday word when the words put it next to a cue, or the conversation knows it", async () => {
    const cued = await prematch("surat me kutta ghayal hai");
    expect(cued.prematched).toMatchObject({ matchType: "area", source: "words", units: [{ display_name: "Arham Animal Ambulance, Surat" }] });
    expect(cued.ctx.lastAmbulanceMatch).toBe("area");
    const known = await prematch("kutte ki surat pe chot hai", { city: "Surat", area: null });
    expect(known.prematched).toMatchObject({ source: "words", units: [{ display_name: "Arham Animal Ambulance, Surat" }] });
  });

  it("leaves the known location's lookup as it was: offered, never armed, never checked against the words", async () => {
    const { prematched, ctx, record } = await prematch("ok", { city: "Mumbai", area: "Ghatkopar" });
    expect(prematched).toMatchObject({ matchType: "area", source: "known_location", units: [{ display_name: "Arham Animal Ambulance, Ghatkopar" }] });
    expect(ctx.lastAmbulanceMatch).toBeNull();
    expect(record.output).not.toHaveProperty("skipped");
  });
});
