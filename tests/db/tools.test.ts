import { describe, it, expect, beforeEach } from "vitest";
import { resetDb } from "../helpers/db";
import { seedDirectory } from "../helpers/fixtures";
import { HandleRegistry } from "@/server/agent/handles";
import { createArhamTools, findAmbulancesImpl, findClinicsImpl, getInfoImpl, TOOL_NAMES, type ToolContext } from "@/server/agent/tools";

function ctx(): ToolContext {
  return { conversationId: "conv-1", language: "en", registry: new HandleRegistry("conv-1"), calls: [], lastAmbulanceCandidates: null, lastAmbulanceMatch: null };
}

describe("tools", () => {
  beforeEach(async () => { await resetDb(); await seedDirectory(); });

  it("find_ambulances returns handles and never phone digits", async () => {
    const c = ctx();
    const out = await findAmbulancesImpl(c, { city: "Mumbai", area: "Ghatkopar", query: "ghatkopar" });
    expect(out.candidates).toHaveLength(1);
    expect(out.candidates[0].handle).toMatch(/^amb_[a-p]{8}$/);
    expect(out.candidates[0].display_name).toBe("Arham Animal Ambulance, Ghatkopar");
    expect(JSON.stringify(out)).not.toMatch(/\d{7,}/);
    expect(c.registry.resolve(out.candidates[0].handle)?.kind).toBe("ambulance");
    expect(c.lastAmbulanceCandidates).toHaveLength(1);
    expect(c.lastAmbulanceMatch).toBe(out.match);
  });

  it("find_ambulances returns the area list for a big city", async () => {
    const out = await findAmbulancesImpl(ctx(), { city: "Mumbai", area: null, query: "mumbai" });
    expect(out.candidates.length).toBe(6);
    expect(out.city_areas).toEqual(["Andheri", "Bandra", "Chembur", "Ghatkopar", "Malad", "Mulund"]);
  });

  it("find_ambulances labels partner units", async () => {
    const out = await findAmbulancesImpl(ctx(), { query: "rajkot" });
    expect(out.candidates.map((c) => c.operator_is_arham)).toEqual([false, false]);
    expect(out.candidates.map((c) => c.operator_name).sort()).toEqual(["Blue Cross", "Hope for Indies Trust"]);
  });

  it("find_clinics filters by city and returns handles", async () => {
    const c = ctx();
    const out = await findClinicsImpl(c, { city: "Surat" });
    expect(out.clinics).toHaveLength(1);
    expect(out.clinics[0].handle).toMatch(/^cli_/);
    expect(JSON.stringify(out)).not.toMatch(/\d{7,}/);
    expect((await findClinicsImpl(c, { city: "Mumbai" })).clinics).toHaveLength(0);
    expect((await findClinicsImpl(c, {})).clinics).toHaveLength(1);
  });

  it("get_info returns localized content with tokens only", () => {
    const out = getInfoImpl({ ...ctx(), language: "hi" }, { topic: "helpline" });
    expect(out.phone).toBe("{{PHONE:helpline}}");
    expect(JSON.stringify(getInfoImpl(ctx(), { topic: "donate" }))).not.toMatch(/\d{7,}/);
  });

  it("wraps the tools in an SDK MCP server and records calls", async () => {
    const c = ctx();
    const { server, allowedToolNames } = createArhamTools(c);
    expect(server.instance).toBeTruthy();
    expect(allowedToolNames).toEqual(TOOL_NAMES);
    await findAmbulancesImpl(c, { query: "surat" });
    expect(c.calls[0]).toMatchObject({ name: "find_ambulances", input: { query: "surat" } });
    expect(c.calls[0].durationMs).toBeGreaterThanOrEqual(0);
  });
});
