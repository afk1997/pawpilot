import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Language } from "../types";
import { HandleRegistry } from "./handles";
import { loadActiveAmbulances, loadActiveClinics } from "../directory/repo";
import { matchAmbulances, normalize, type DirectoryAmbulance, type MatchInput, type MatchResult, type MatchType } from "../directory/matcher";
import { ambulanceDisplayName } from "../messages/cards";
import { getStaticInfo, type InfoContent, type InfoTopic } from "../content/static";
import { asciiDigits, PHONE_RUN_RE } from "../digits";
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

/** The SDK's hard per-call limit for this server. */
const SERVER_TIMEOUT_MS = 10_000;
/** Below SERVER_TIMEOUT_MS, so a stalled lookup is recorded and answered here rather than cut off by the SDK. */
export const LOOKUP_DEADLINE_MS = 8_000;

/** A lookup that missed LOOKUP_DEADLINE_MS; the call record keeps this class name. */
class TimeoutError extends Error {
  name = "TimeoutError";
}

export interface FindAmbulancesOutput {
  candidates: AmbulanceCandidate[];
  match: MatchType | null;
  city_areas: string[] | null;
  out_of_coverage: boolean;
}

export interface AmbulanceCandidate {
  handle: string; display_name: string; city: string; area: string | null; areas_covered: string[];
  category: string; operator_name: string; operator_is_arham: boolean;
}

/** A unit as find_ambulances gives it to the model: its handle, issued through the turn's registry, and never its number. */
function ambulanceCandidate(ctx: ToolContext, r: DirectoryAmbulance): AmbulanceCandidate {
  return {
    handle: ctx.registry.ambulance(r.id),
    display_name: ambulanceDisplayName(r),
    city: r.city,
    area: r.area,
    areas_covered: r.areasCovered,
    category: r.category,
    operator_name: r.operatorName,
    operator_is_arham: r.operatorIsArham,
  };
}

export interface FindClinicsOutput {
  clinics: { handle: string; label: string; city: string; area: string | null; address: string | null; hours: string | null }[];
  /** False when a city was given and no clinic is in it; `clinics` is then the full list. */
  city_matched: boolean;
}

/**
 * The form a phone number cannot hide from: every decimal digit as ASCII (Devanagari, Gujarati, Bengali, Tamil,
 * Telugu, Kannada, fullwidth, …); invisible characters dropped (soft hyphen, zero-width space, word joiner, and
 * zero-width (non-)joiners next to a digit, which elsewhere shape Indic text); every whitespace run as one space;
 * every dash variant as "-".
 */
function normalizeForScrub(s: string): string {
  return asciiDigits(s)
    .replace(/[\u00AD\u200B\u2060]/g, "")
    .replace(/(?<=\d)[\u200C\u200D]+|[\u200C\u200D]+(?=\d)/g, "")
    .replace(/\s+/g, " ")
    .replace(/[\u2010-\u2015\u2212\uFE63\uFF0D]/g, "-");
}

/**
 * The digit guard on tool output: normalizes (normalizeForScrub), then removes phone-shaped runs (PHONE_RUN_RE, from
 * src/server/digits.ts), then collapses the double spaces a removal leaves. `removed` says whether a run was taken out.
 */
export function scrubToolText(s: string): { text: string; removed: boolean } {
  let removed = false;
  const text = normalizeForScrub(s)
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

/**
 * Runs a lookup against LOOKUP_DEADLINE_MS and records the call once: its scrubbed output, or its failure (a
 * TimeoutError when the deadline wins). A lookup that settles after its deadline is ignored.
 */
async function timed<T>(ctx: ToolContext, name: string, input: unknown, fn: () => Promise<T>): Promise<T> {
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(`${name} missed its ${LOOKUP_DEADLINE_MS} ms deadline`)), LOOKUP_DEADLINE_MS);
  });
  try {
    return succeed(ctx, name, input, started, await Promise.race([fn(), deadline]));
  } catch (e) {
    recordFailure(ctx, name, input, started, e);
    throw e;
  } finally {
    clearTimeout(timer);
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
  // Filled by the lookup but copied to ctx only once timed() resolves, so a lookup that settles after its
  // deadline cannot write the state.
  const found: { result?: MatchResult } = {};
  const output = await timed(ctx, "find_ambulances", input, async () => {
    const rows = await loadActiveAmbulances();
    const result = matchAmbulances(rows, { city: input.city ?? null, area: input.area ?? null, query: input.query });
    found.result = result;
    return {
      candidates: result.candidates.map((r) => ambulanceCandidate(ctx, r)),
      match: result.match,
      city_areas: result.cityAreas,
      out_of_coverage: result.outOfCoverage,
    };
  });
  ctx.lastAmbulanceCandidates = found.result?.candidates ?? null;
  ctx.lastAmbulanceMatch = found.result?.match ?? null;
  return output;
}

/** A unit the pre-match hands the model in the turn prompt (buildTurnPrompt's PRE-MATCHED UNITS). */
export type PrematchedUnit = Pick<AmbulanceCandidate, "handle" | "display_name" | "city" | "area" | "operator_name" | "operator_is_arham">;

export interface Prematched {
  matchType: "area" | "city";
  units: PrematchedUnit[];
}

/** The most units a pre-match hands the model: as many as the card fallback lists. */
const PREMATCH_MAX_UNITS = 3;

/**
 * find_ambulances run by code before the model's first call, on the reporter's words (`query`), and when they match
 * no place at all, again with the place known so far as its city and area. An exact match (area or city) of one to
 * PREMATCH_MAX_UNITS units issues their handles and sets the tool's state, as find_ambulances would, so the model can
 * give them without calling it and a reply without a token still gets their card; any looser match, or more units,
 * leaves the lookup to the model. The units are scrubbed as tool output is. `record`: the audit entry (name
 * "prematch"), whatever the outcome; a failed lookup is recorded with its error's class and code, and throws nothing.
 */
export async function prematchAmbulances(
  ctx: ToolContext,
  input: { query: string; knownLocation: { city: string | null; area: string | null } | null }
): Promise<{ prematched: Prematched | null; record: ToolCallRecord }> {
  const started = Date.now();
  let lookup: MatchInput = { query: input.query };
  try {
    const rows = await loadActiveAmbulances();
    let result = matchAmbulances(rows, lookup);
    const known = input.knownLocation;
    if (result.match === null && known && (known.city || known.area)) {
      lookup = { city: known.city, area: known.area, query: input.query };
      result = matchAmbulances(rows, lookup);
    }
    const count = result.candidates.length;
    let prematched: Prematched | null = null;
    let removed = false;
    if ((result.match === "area" || result.match === "city") && count >= 1 && count <= PREMATCH_MAX_UNITS) {
      const scrubbed = scrubDeep(
        result.candidates.map((r): PrematchedUnit => {
          const { handle, display_name, city, area, operator_name, operator_is_arham } = ambulanceCandidate(ctx, r);
          return { handle, display_name, city, area, operator_name, operator_is_arham };
        })
      );
      removed = scrubbed.removed;
      if (removed) log.warn({ conversationId: ctx.conversationId, tool: "prematch" }, "digits removed from tool output");
      prematched = { matchType: result.match, units: scrubbed.value };
      ctx.lastAmbulanceCandidates = result.candidates;
      ctx.lastAmbulanceMatch = result.match;
    }
    const output = { matchType: result.match, count, handles: prematched?.units.map((u) => u.handle) ?? [] };
    return { prematched, record: { name: "prematch", input: lookup, output, durationMs: Date.now() - started, ...(removed && { scrubbed: true }) } };
  } catch (e) {
    return { prematched: null, record: { name: "prematch", input: lookup, output: null, durationMs: Date.now() - started, error: safeErrorFields(e) } };
  }
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
/** What the model gets when a lookup throws or misses its deadline; the call record keeps the error's class and code (see timed). */
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
    timeout: SERVER_TIMEOUT_MS,
    tools: [
      tool(
        "find_ambulances",
        "Find animal ambulances covering a location. Pass the city and area you understood from the reporter (normalize typos and Indic spellings yourself using the coverage list) plus the reporter's own words as query. Returns candidates with an opaque handle each; to give a number write {{AMB:<handle>}} in your reply, copying the handle exactly as returned including its amb_ prefix (for example {{AMB:amb_kcmfpbca}}). Never returns phone digits.",
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
        "List Arham clinics, optionally filtered by city. Returns handles; write {{CLINIC:<handle>}} to give a clinic's number. city_matched false: no clinic is in the city you passed and every clinic is listed; tell the reporter that, and name each clinic's city before giving its number.",
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
