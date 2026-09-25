import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Language } from "../types";
import { HandleRegistry } from "./handles";
import { loadActiveAmbulances, loadActiveClinics } from "../directory/repo";
import { matchAmbulances, normalize, type DirectoryAmbulance, type MatchType } from "../directory/matcher";
import { ambulanceDisplayName } from "../messages/cards";
import { foldDigits, getStaticInfo, type InfoContent, type InfoTopic } from "../content/static";
import { log, safeErrorFields } from "../log";

export interface ToolCallRecord {
  name: string;
  input: unknown;
  output: unknown;
  durationMs: number;
  /** Class and code of the thrown error, never its message (which can quote data). */
  error?: ReturnType<typeof safeErrorFields>;
  /** True when the digit guard removed a phone-shaped run from the output. */
  scrubbed?: boolean;
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

export interface FindClinicsOutput {
  clinics: { handle: string; label: string; city: string; area: string | null; address: string | null; hours: string | null }[];
  /** False when a city was given and no clinic is in it; `clinics` is then the full list. */
  city_matched: boolean;
}

/** A phone number's shape: 7+ digits, at most one space or hyphen between two digits. */
const PHONE_RUN_RE = /\+?\d(?:[ -]?\d){6,}/g;

/**
 * The digit guard on tool output: folds Devanagari/Gujarati numerals, removes phone-shaped runs and collapses
 * double spaces. `removed` says whether a run was taken out.
 */
export function scrubToolText(s: string): { text: string; removed: boolean } {
  let removed = false;
  const text = foldDigits(s)
    .replace(PHONE_RUN_RE, () => {
      removed = true;
      return "";
    })
    .replace(/ {2,}/g, " ");
  return { text, removed };
}

/** scrubToolText on every string in a JSON-like value, recursively. */
function scrubDeep<T>(value: T): { value: T; removed: boolean } {
  let removed = false;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      const r = scrubToolText(v);
      if (r.removed) removed = true;
      return r.text;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  const out = walk(value) as T;
  return { value: out, removed };
}

/**
 * Records a successful call with its scrubbed output, the only version the model sees, and returns that output.
 * The push comes last, so a throw here leaves only the failure record.
 */
function succeed<T>(ctx: ToolContext, name: string, input: unknown, started: number, raw: T): T {
  const { value: output, removed } = scrubDeep(raw);
  if (removed) log.warn({ conversationId: ctx.conversationId, tool: name }, "digits removed from tool output");
  ctx.calls.push({ name, input, output, durationMs: Date.now() - started, ...(removed && { scrubbed: true }) });
  return output;
}

function recordFailure(ctx: ToolContext, name: string, input: unknown, started: number, e: unknown): void {
  ctx.calls.push({ name, input, output: null, durationMs: Date.now() - started, error: safeErrorFields(e) });
}

async function timed<T>(ctx: ToolContext, name: string, input: unknown, fn: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    return succeed(ctx, name, input, started, await fn());
  } catch (e) {
    recordFailure(ctx, name, input, started, e);
    throw e;
  }
}

/** timed for synchronous tools, so their failures are recorded the same way. */
function timedSync<T>(ctx: ToolContext, name: string, input: unknown, fn: () => T): T {
  const started = Date.now();
  try {
    return succeed(ctx, name, input, started, fn());
  } catch (e) {
    recordFailure(ctx, name, input, started, e);
    throw e;
  }
}

export async function findAmbulancesImpl(
  ctx: ToolContext,
  input: { city?: string | null; area?: string | null; query: string }
): Promise<FindAmbulancesOutput> {
  // Cleared first, so a failed search never leaves an earlier search's units for the card fallback.
  ctx.lastAmbulanceCandidates = null;
  ctx.lastAmbulanceMatch = null;
  return timed(ctx, "find_ambulances", input, async () => {
    const rows = await loadActiveAmbulances();
    const result = matchAmbulances(rows, { city: input.city ?? null, area: input.area ?? null, query: input.query });
    const candidates = result.candidates.map((r) => ({
      handle: ctx.registry.ambulance(r.id),
      display_name: ambulanceDisplayName(r),
      city: r.city,
      area: r.area,
      areas_covered: r.areasCovered,
      category: r.category,
      operator_name: r.operatorName,
      operator_is_arham: r.operatorIsArham,
    }));
    ctx.lastAmbulanceCandidates = result.candidates;
    ctx.lastAmbulanceMatch = result.match;
    return {
      candidates,
      match: result.match,
      city_areas: result.cityAreas,
      out_of_coverage: result.outOfCoverage,
    };
  });
}

export async function findClinicsImpl(ctx: ToolContext, input: { city?: string | null }): Promise<FindClinicsOutput> {
  return timed(ctx, "find_clinics", input, async () => {
    const rows = await loadActiveClinics();
    // Exact after normalize, which applies the Latin/Indic city aliases; a city that normalizes to "" counts as none.
    const wanted = input.city ? normalize(input.city) : "";
    const inCity = wanted ? rows.filter((c) => normalize(c.city) === wanted) : rows;
    const cityMatched = !wanted || inCity.length > 0;
    return {
      clinics: (cityMatched ? inCity : rows).map((c) => ({
        handle: ctx.registry.clinic(c.id),
        label: c.label, city: c.city, area: c.area, address: c.address, hours: c.hours,
      })),
      city_matched: cityMatched,
    };
  });
}

export function getInfoImpl(ctx: ToolContext, input: { topic: InfoTopic }): InfoContent {
  return timedSync(ctx, "get_info", input, () => getStaticInfo(input.topic, ctx.language));
}

const text = (o: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(o) }] });
/** What the model gets when a lookup throws; the call record keeps the error's class and code (see timed). */
const lookupFailed = () => ({ content: [{ type: "text" as const, text: JSON.stringify({ error: "lookup_failed" }) }], isError: true });

export function createArhamTools(ctx: ToolContext): {
  server: McpSdkServerConfigWithInstance;
  /** Keyed by SERVER_NAME, which the mcp__arham__ prefix of TOOL_NAMES depends on. */
  mcpServers: Record<string, McpSdkServerConfigWithInstance>;
  allowedToolNames: string[];
} {
  const server = createSdkMcpServer({
    name: SERVER_NAME,
    version: "2.0.0",
    // A stalled lookup fails the call after 10 s instead of holding the turn.
    timeout: 10_000,
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
          } catch {
            return lookupFailed();
          }
        }
      ),
      tool(
        "find_clinics",
        "List Arham clinics, optionally filtered by city. Returns handles; write {{CLINIC:<handle>}} to give a clinic's number. city_matched false means no clinic is in that city and the full list is returned.",
        { city: z.string().nullable().optional().describe("City as spelled in the coverage list, or null") },
        async (args) => {
          try {
            return text(await findClinicsImpl(ctx, { city: args.city ?? null }));
          } catch {
            return lookupFailed();
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
          } catch {
            return lookupFailed();
          }
        }
      ),
    ],
  });
  return { server, mcpServers: { [SERVER_NAME]: server }, allowedToolNames: TOOL_NAMES };
}
