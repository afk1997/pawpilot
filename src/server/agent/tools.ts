import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Language } from "../types";
import { HandleRegistry } from "./handles";
import { loadActiveAmbulances, loadActiveClinics } from "../directory/repo";
import { matchAmbulances, normalize, type DirectoryAmbulance, type MatchType } from "../directory/matcher";
import { fuzzyEqual } from "../directory/fuzzy";
import { ambulanceDisplayName } from "../messages/cards";
import { getStaticInfo, type InfoContent, type InfoTopic } from "../content/static";

export interface ToolCallRecord {
  name: string;
  input: unknown;
  output: unknown;
  durationMs: number;
  error?: string;
}

export interface ToolContext {
  conversationId: string;
  language: Language;
  registry: HandleRegistry;
  calls: ToolCallRecord[];
  lastAmbulanceCandidates: DirectoryAmbulance[] | null;
  /** How lastAmbulanceCandidates matched: the card fallback fires only for "area" or "city", since a looser match means the model is confirming the place. */
  lastAmbulanceMatch: MatchType | null;
}

export const SERVER_NAME = "arham";
export const TOOL_NAMES = [`mcp__${SERVER_NAME}__find_ambulances`, `mcp__${SERVER_NAME}__find_clinics`, `mcp__${SERVER_NAME}__get_info`];

export interface FindAmbulancesOutput {
  candidates: {
    handle: string; display_name: string; city: string; area: string | null; areas_covered: string[];
    category: string; operator_name: string; operator_is_arham: boolean;
  }[];
  match: MatchType | null;
  city_areas: string[] | null;
  out_of_coverage: boolean;
}

async function timed<T>(ctx: ToolContext, name: string, input: unknown, fn: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    const output = await fn();
    ctx.calls.push({ name, input, output, durationMs: Date.now() - started });
    return output;
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    ctx.calls.push({ name, input, output: null, durationMs: Date.now() - started, error });
    throw e;
  }
}

export async function findAmbulancesImpl(
  ctx: ToolContext,
  input: { city?: string | null; area?: string | null; query: string }
): Promise<FindAmbulancesOutput> {
  return timed(ctx, "find_ambulances", input, async () => {
    const rows = await loadActiveAmbulances();
    const result = matchAmbulances(rows, { city: input.city ?? null, area: input.area ?? null, query: input.query });
    ctx.lastAmbulanceCandidates = result.candidates;
    ctx.lastAmbulanceMatch = result.match;
    return {
      candidates: result.candidates.map((r) => ({
        handle: ctx.registry.ambulance(r.id),
        display_name: ambulanceDisplayName(r),
        city: r.city,
        area: r.area,
        areas_covered: r.areasCovered,
        category: r.category,
        operator_name: r.operatorName,
        operator_is_arham: r.operatorIsArham,
      })),
      match: result.match,
      city_areas: result.cityAreas,
      out_of_coverage: result.outOfCoverage,
    };
  });
}

export async function findClinicsImpl(ctx: ToolContext, input: { city?: string | null }) {
  return timed(ctx, "find_clinics", input, async () => {
    const rows = await loadActiveClinics();
    const wanted = input.city ? normalize(input.city) : "";
    const filtered = wanted ? rows.filter((c) => normalize(c.city) === wanted || fuzzyEqual(normalize(c.city), wanted)) : rows;
    return {
      clinics: filtered.map((c) => ({
        handle: ctx.registry.clinic(c.id),
        label: c.label, city: c.city, area: c.area, address: c.address, hours: c.hours,
      })),
    };
  });
}

export function getInfoImpl(ctx: ToolContext, input: { topic: InfoTopic }): InfoContent {
  const started = Date.now();
  const output = getStaticInfo(input.topic, ctx.language);
  ctx.calls.push({ name: "get_info", input, output, durationMs: Date.now() - started });
  return output;
}

const text = (o: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(o) }] });
const errorResult = (e: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify({ error: e instanceof Error ? e.message : String(e) }) }], isError: true });

export function createArhamTools(ctx: ToolContext): { server: McpSdkServerConfigWithInstance; allowedToolNames: string[] } {
  const server = createSdkMcpServer({
    name: SERVER_NAME,
    version: "2.0.0",
    tools: [
      tool(
        "find_ambulances",
        "Find animal ambulances covering a location. Pass the city and area you understood from the reporter (normalize typos and Indic spellings yourself using the coverage list) plus the reporter's own words as query. Returns candidates with an opaque handle each; to give a number write {{AMB:<handle>}} in your reply. Never returns phone digits.",
        {
          city: z.string().nullable().optional().describe("City as spelled in the coverage list, or null if unknown"),
          area: z.string().nullable().optional().describe("Area/suburb/landmark as spelled in the coverage list, or null"),
          query: z.string().describe("The reporter's own location words"),
        },
        async (args) => {
          try {
            return text(await findAmbulancesImpl(ctx, { city: args.city ?? null, area: args.area ?? null, query: args.query }));
          } catch (e) {
            return errorResult(e);
          }
        }
      ),
      tool(
        "find_clinics",
        "List Arham clinics, optionally filtered by city. Returns handles; write {{CLINIC:<handle>}} to give a clinic's number.",
        { city: z.string().nullable().optional() },
        async (args) => {
          try {
            return text(await findClinicsImpl(ctx, { city: args.city ?? null }));
          } catch (e) {
            return errorResult(e);
          }
        }
      ),
      tool(
        "get_info",
        "Static information: donate, volunteer, about, faq, human_emergency (112/108 text), helpline (the {{PHONE:helpline}} token to hand over when you cannot help).",
        { topic: z.enum(["donate", "volunteer", "about", "faq", "human_emergency", "helpline"]) },
        async (args) => {
          try {
            return text(getInfoImpl(ctx, { topic: args.topic }));
          } catch (e) {
            return errorResult(e);
          }
        }
      ),
    ],
  });
  return { server, allowedToolNames: TOOL_NAMES };
}
