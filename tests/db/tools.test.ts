import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { resetDb } from "../helpers/db";
import { seedDirectory, type DirectoryIds } from "../helpers/fixtures";
import { getDb } from "@/server/db/client";
import { ambulances, clinics } from "@/server/db/schema";
import * as repo from "@/server/directory/repo";
import * as staticContent from "@/server/content/static";
import { foldDigits } from "@/server/content/static";
import { log } from "@/server/log";
import { LANGUAGES } from "@/server/types";
import { HandleRegistry } from "@/server/agent/handles";
import { createArhamTools, findAmbulancesImpl, findClinicsImpl, getInfoImpl, scrubToolText, SERVER_NAME, TOOL_NAMES, type ToolContext } from "@/server/agent/tools";

/** The tool-boundary guard's phone shape, checked after folding Devanagari/Gujarati numerals. */
const PHONE_SHAPED = /\+?\d(?:[ -]?\d){6,}/;
const hasPhoneRun = (o: unknown) => PHONE_SHAPED.test(foldDigits(JSON.stringify(o)));
const LOOKUP_FAILED = [{ type: "text", text: JSON.stringify({ error: "lookup_failed" }) }];

function ctx(): ToolContext {
  return { conversationId: "conv-1", language: "en", registry: new HandleRegistry("conv-1"), calls: [], lastAmbulanceCandidates: null, lastAmbulanceMatch: null };
}

const clients: Client[] = [];

/** An MCP client wired to a fresh tool server over an in-memory transport pair. */
async function connect(c: ToolContext): Promise<Client> {
  const { server } = createArhamTools(c);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(serverTransport);
  const client = new Client({ name: "tools-test", version: "1.0.0" });
  await client.connect(clientTransport);
  clients.push(client);
  return client;
}

/** The text of a tool result's first content block (callTool's result type also has a content-less variant). */
const textOf = (res: unknown) => (res as { content: { type: string; text: string }[] }).content[0].text;

describe("tools", () => {
  let ids: DirectoryIds;
  beforeEach(async () => { await resetDb(); ids = await seedDirectory(); });
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(clients.splice(0).map((client) => client.close()));
  });

  /** Test-local rows, so the shared fixture (whose single clinic other suites rely on) stays unchanged. */
  const addClinic = (label: string, city: string, address: string | null = null) =>
    getDb().insert(clinics).values({ operatorId: ids.arhamOperatorId, label, city, area: null, state: "Maharashtra", phone: "+917000000090", address, hours: null });

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
    expect(out.city_matched).toBe(true);
    expect(out.clinics[0].handle).toMatch(/^cli_/);
    expect(JSON.stringify(out)).not.toMatch(/\d{7,}/);
    const mumbai = await findClinicsImpl(c, { city: "Mumbai" });
    expect(mumbai.city_matched).toBe(false);
    expect(mumbai.clinics).toHaveLength(1);
    expect((await findClinicsImpl(c, {})).clinics).toHaveLength(1);
  });

  it("find_clinics matches the city exactly (aliases included) and otherwise returns the full list", async () => {
    await addClinic("Arham Clinic Nagpur", "Nagpur");
    const c = ctx();
    const nearMiss = await findClinicsImpl(c, { city: "Nagaur" });
    expect(nearMiss.city_matched).toBe(false);
    expect(nearMiss.clinics.map((x) => x.city).sort()).toEqual(["Nagpur", "Surat"]);
    const alias = await findClinicsImpl(c, { city: "नागपुर" });
    expect(alias.city_matched).toBe(true);
    expect(alias.clinics.map((x) => x.label)).toEqual(["Arham Clinic Nagpur"]);
    const dash = await findClinicsImpl(c, { city: "-" });
    expect(dash.city_matched).toBe(true);
    expect(dash.clinics).toHaveLength(2);
  });

  it("get_info returns localized content with tokens only", () => {
    const out = getInfoImpl({ ...ctx(), language: "hi" }, { topic: "helpline" });
    expect(out.phone).toBe("{{PHONE:helpline}}");
    expect(JSON.stringify(getInfoImpl(ctx(), { topic: "donate" }))).not.toMatch(/\d{7,}/);
  });

  it("scrubToolText folds native numerals and removes only phone-shaped runs", () => {
    expect(scrubToolText("call +91 98765-43210 now")).toEqual({ text: "call now", removed: true });
    expect(scrubToolText("फोन ९८७६५४३२१० करें")).toEqual({ text: "फोन करें", removed: true });
    expect(scrubToolText("Open 9am-7pm since 2019, gate 12")).toEqual({ text: "Open 9am-7pm since 2019, gate 12", removed: false });
  });

  it("removes phone-shaped runs from what the tools return, flags the call and warns", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    await getDb().insert(ambulances).values({
      operatorId: ids.arhamOperatorId, label: "Thane", city: "Thane", area: null, state: "Maharashtra",
      phone: "+917000000091", phoneRaw: "+917000000091", areasCovered: ["Thane", "98765 43210"],
    });
    await addClinic("Arham Clinic Thane", "Thane", "Gokhale Road, call ९८७६५४३२१० first");
    const c = ctx();
    const amb = await findAmbulancesImpl(c, { city: "Thane", query: "thane" });
    const cli = await findClinicsImpl(c, { city: "Thane" });
    await findClinicsImpl(c, { city: "Surat" });
    expect(amb.candidates.map((x) => x.areas_covered)).toEqual([["Thane", ""]]);
    expect(cli.clinics.map((x) => x.address)).toEqual(["Gokhale Road, call first"]);
    expect(hasPhoneRun(amb)).toBe(false);
    expect(hasPhoneRun(cli)).toBe(false);
    expect(c.calls.map((r) => r.scrubbed)).toEqual([true, true, undefined]);
    expect(c.calls[1].output).toEqual(cli);
    expect(warn.mock.calls).toEqual([
      [{ conversationId: "conv-1", tool: "find_ambulances" }, "digits removed from tool output"],
      [{ conversationId: "conv-1", tool: "find_clinics" }, "digits removed from tool output"],
    ]);
  });

  it("wraps the tools in an SDK MCP server and records calls", async () => {
    const c = ctx();
    const { server, mcpServers, allowedToolNames } = createArhamTools(c);
    expect(server.instance).toBeTruthy();
    expect(server.timeout).toBe(10_000);
    expect(Object.keys(mcpServers)).toEqual([SERVER_NAME]);
    expect(mcpServers[SERVER_NAME]).toBe(server);
    expect(allowedToolNames).toEqual(TOOL_NAMES);
    await findAmbulancesImpl(c, { query: "surat" });
    expect(c.calls[0]).toMatchObject({ name: "find_ambulances", input: { query: "surat" } });
    expect(c.calls[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  describe("over MCP", () => {
    it("lists the three tools with their input schemas", async () => {
      const { tools } = await (await connect(ctx())).listTools();
      expect(tools.map((t) => t.name)).toEqual(["find_ambulances", "find_clinics", "get_info"]);
      const schema = Object.fromEntries(tools.map((t) => [t.name, t.inputSchema]));
      expect(Object.keys(schema.find_ambulances.properties ?? {})).toEqual(["city", "area", "query"]);
      expect(schema.find_ambulances.required).toEqual(["query"]);
      expect(schema.find_clinics.properties).toMatchObject({ city: { description: "City as spelled in the coverage list, or null" } });
      expect(schema.find_clinics.required).toBeUndefined();
      expect(schema.get_info.properties).toEqual({ topic: { type: "string", enum: ["donate", "volunteer", "about", "faq", "human_emergency", "helpline"] } });
      expect(schema.get_info.required).toEqual(["topic"]);
    });

    it("answers find_ambulances with JSON content and records the call", async () => {
      const c = ctx();
      const res = await (await connect(c)).callTool({ name: "find_ambulances", arguments: { city: "Mumbai", area: "Ghatkopar", query: "ghatkopar" } });
      expect(res.isError).toBeFalsy();
      const body = JSON.parse(textOf(res));
      expect(body.candidates.map((x: { display_name: string }) => x.display_name)).toEqual(["Arham Animal Ambulance, Ghatkopar"]);
      expect(c.registry.resolve(body.candidates[0].handle)?.kind).toBe("ambulance");
      expect(c.calls).toEqual([
        { name: "find_ambulances", input: { city: "Mumbai", area: "Ghatkopar", query: "ghatkopar" }, output: body, durationMs: expect.any(Number) },
      ]);
    });

    it("returns a fixed error when a lookup fails, records only the error class and code, and clears the last search", async () => {
      const c = ctx();
      const client = await connect(c);
      await client.callTool({ name: "find_ambulances", arguments: { city: "Mumbai", area: "Ghatkopar", query: "ghatkopar" } });
      expect(c.lastAmbulanceMatch).toBe("area");
      vi.spyOn(repo, "loadActiveAmbulances").mockRejectedValueOnce(
        Object.assign(new Error("connect ECONNREFUSED 10.0.0.5:5432 while serving +919876543210"), { code: "ECONNREFUSED" })
      );
      const res = await client.callTool({ name: "find_ambulances", arguments: { query: "surat" } });
      expect(res.isError).toBe(true);
      expect(res.content).toEqual(LOOKUP_FAILED);
      expect(c.calls[1]).toEqual({
        name: "find_ambulances", input: { city: null, area: null, query: "surat" }, output: null, durationMs: expect.any(Number),
        error: { errorClass: "Error", code: "ECONNREFUSED" },
      });
      expect(c.lastAmbulanceCandidates).toBeNull();
      expect(c.lastAmbulanceMatch).toBeNull();
    });

    it("records a failed get_info by class only and answers with the fixed error", async () => {
      const c = ctx();
      const client = await connect(c);
      vi.spyOn(staticContent, "getStaticInfo").mockImplementation(() => {
        throw new TypeError("content for +919876543210 is broken");
      });
      const res = await client.callTool({ name: "get_info", arguments: { topic: "donate" } });
      expect(res.isError).toBe(true);
      expect(res.content).toEqual(LOOKUP_FAILED);
      expect(c.calls).toEqual([{ name: "get_info", input: { topic: "donate" }, output: null, durationMs: expect.any(Number), error: { errorClass: "TypeError" } }]);
    });

    it("never returns a phone-shaped run from get_info, for any topic in any language", async () => {
      const c = ctx();
      const client = await connect(c);
      const { tools } = await client.listTools();
      const topics = (tools.find((t) => t.name === "get_info")?.inputSchema.properties?.topic as { enum: string[] }).enum;
      expect(topics).toHaveLength(6);
      for (const lang of LANGUAGES) {
        c.language = lang;
        for (const topic of topics) {
          const res = await client.callTool({ name: "get_info", arguments: { topic } });
          expect(res.isError, `${topic}/${lang}`).toBeFalsy();
          expect(foldDigits(textOf(res)), `${topic}/${lang}`).not.toMatch(PHONE_SHAPED);
        }
      }
      expect(c.calls).toHaveLength(LANGUAGES.length * topics.length);
      expect(c.calls.filter((r) => r.scrubbed || r.error)).toEqual([]);
    });
  });
});
