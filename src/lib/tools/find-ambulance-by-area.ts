/**
 * Tool: find_ambulance_by_area
 *
 * Fuzzy-matches free-text location ("Mumbai Ghatkopar", "near Phoenix
 * Marketcity", Devanagari/Gujarati script, etc.) to ambulance rows from the
 * directory.
 *
 * The tool returns plain rows; the caller (LLM via the orchestrator) types
 * prose around the result. Phone numbers are real DB values — never typed
 * by the LLM.
 *
 * Match strategy (in order):
 *   1. Exact city match (case-insensitive).
 *   2. Exact area-covered match (city's areas_covered array contains query).
 *   3. Substring match in `label` or `area`.
 *   4. Substring match in any element of `areas_covered`.
 * If nothing matches, returns empty.
 */
import { z } from "zod";
import { tool } from "ai";
import { supabase } from "../supabase";
import { buildAmbulanceCard, formatIndianPhone } from "../ambulance-card";
import { fuzzyEqual } from "../fuzzy-match";
import { neighborCandidates } from "../area-neighbors";
import { applyCityAliases } from "../city-aliases";
import type { Language } from "../types";

export const findAmbulanceByAreaParams = z.object({
  query: z
    .string()
    .min(1)
    .describe(
      "Free-text location from the reporter — city name, area, landmark, in any supported language/script."
    ),
  language: z
    .enum(["en", "hi", "mr", "gu"])
    .optional()
    .describe("Reporter's language; used to localize the operator suffix."),
});

export type FindAmbulanceByAreaInput = z.infer<typeof findAmbulanceByAreaParams>;

export interface AmbulanceRow {
  id: string;
  label: string;
  city: string;
  area: string | null;
  state: string;
  areas_covered: string[];
  category: string;
  operator_name: string;
  operator_is_arham: boolean;
  /** E.164 phone, e.g. "+917662005404". Source of truth from the directory. */
  phone: string;
  /** Pretty-printed phone, e.g. "+91 76620 05404". */
  phone_formatted: string;
  /** Pre-formatted line 1 of the dispatch card. The orchestrator pastes this verbatim. */
  display_name: string;
  /** Suffix for partner-NGO ambulances; null when Arham-operated. */
  operator_suffix: string | null;
}

/**
 * Normalize a string for fuzzy matching: lowercase, strip non-alphanum,
 * then map colloquial city names (Bangalore, Bombay, …) to canonical
 * (Bengaluru, Mumbai) so user-side aliasing matches directory-side spelling.
 */
function norm(s: string): string {
  return applyCityAliases(
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

export async function findAmbulanceByArea(
  input: FindAmbulanceByAreaInput
): Promise<AmbulanceRow[]> {
  const q = norm(input.query);
  if (!q) return [];

  // Pull all active ambulances + operator. With ~45 rows this is trivial in-memory.
  const { data, error } = await supabase
    .from("ambulances")
    .select(
      "id, label, phone, city, area, state, areas_covered, category, ngo_operators(id, name, is_arham)"
    )
    .eq("active", true);

  if (error || !data) {
    console.warn("find_ambulance_by_area: db error", error);
    return [];
  }

  const lang: Language = (input.language as Language | undefined) ?? "en";
  const rows: AmbulanceRow[] = data.map((r) => {
    const op = (r as unknown as { ngo_operators?: { name?: string; is_arham?: boolean } })
      .ngo_operators;
    const operator_name = op?.name ?? "Arham Yuva Seva Group";
    const operator_is_arham = op?.is_arham ?? true;
    const phone = r.phone as string;
    const card = buildAmbulanceCard(
      {
        city: r.city as string,
        area: (r.area as string | null) ?? null,
        phone,
        operator_name,
        operator_is_arham,
      },
      lang
    );
    return {
      id: r.id as string,
      label: r.label as string,
      city: r.city as string,
      area: (r.area as string | null) ?? null,
      state: r.state as string,
      areas_covered: (r.areas_covered as string[]) ?? [],
      category: r.category as string,
      operator_name,
      operator_is_arham,
      phone,
      phone_formatted: formatIndianPhone(phone),
      display_name: card.display_name,
      operator_suffix: card.operator_suffix,
    };
  });

  const tokens = q.split(" ").filter((t) => t.length >= 4);

  const matches = matchInRows(q, tokens, rows);
  if (matches.length > 0) return matches;

  // No direct hit — try fuzzy-equal of any query token against city/area/
  // areas_covered. Rescues common typos like "Munbai" → "Mumbai".
  const fuzzyMatches = rows.filter((r) => {
    const haystack = [r.city, r.area ?? "", ...r.areas_covered]
      .map(norm)
      .filter((h) => h.length >= 4);
    return tokens.some((t) => haystack.some((h) => fuzzyEqual(t, h)));
  });
  if (fuzzyMatches.length > 0) return fuzzyMatches;

  // Still nothing — try geographic neighbors (Goregaon → Malad/Andheri etc.).
  // Use the original query AND each individual token as the lookup key.
  const neighborQueries = new Set<string>();
  for (const k of [q, ...tokens]) {
    for (const n of neighborCandidates(k)) neighborQueries.add(n);
  }
  for (const nq of neighborQueries) {
    const nqTokens = nq.split(" ").filter((t) => t.length >= 4);
    const neighborMatches = matchInRows(nq, nqTokens, rows);
    if (neighborMatches.length > 0) return neighborMatches;
  }

  return [];
}

/**
 * Run the four-tier match (area-exact, city-exact, substring, token) and
 * return the most specific non-empty tier.
 */
function matchInRows(
  q: string,
  tokens: string[],
  rows: AmbulanceRow[]
): AmbulanceRow[] {
  // Tier 1 — area exact match.
  const areaExact = rows.filter((r) => {
    if (r.area && norm(r.area) === q) return true;
    if (r.areas_covered.some((a) => norm(a) === q)) return true;
    return r.areas_covered.some((a) => {
      const na = norm(a);
      return tokens.some((t) => t === na);
    });
  });
  if (areaExact.length > 0) return areaExact;

  // Tier 2 — city exact match.
  const cityMatches = rows.filter((r) => {
    const c = norm(r.city);
    if (c === q) return true;
    if (tokens.length === 1 && tokens[0] === c) return true;
    return false;
  });
  if (cityMatches.length > 0) return cityMatches;

  // Tier 3 — substring (query inside haystack).
  const substring = rows.filter((r) => {
    const haystack = [r.label, r.city, r.area ?? "", ...r.areas_covered].map(norm);
    return haystack.some((h) => h.length >= 4 && h.includes(q));
  });
  if (substring.length > 0) return substring;

  // Tier 4 — token match.
  const tokenMatch = rows.filter((r) => {
    const haystack = [r.label, r.city, r.area ?? "", ...r.areas_covered].map(norm);
    return tokens.some((t) => haystack.some((h) => h === t || h.includes(t)));
  });
  return tokenMatch;
}

export const findAmbulanceByAreaTool = tool({
  description:
    "Find ambulance(s) covering the reporter's location. Returns 0+ rows. Each row includes a `display_name` (e.g. \"Arham Animal Ambulance, Ghatkopar\") and `phone_formatted` (e.g. \"+91 76620 05404\") that the orchestrator pastes verbatim — DO NOT reformat them. If multiple rows match, ask the reporter for the area; if exactly one matches, the orchestrator will deliver it.",
  inputSchema: findAmbulanceByAreaParams,
  execute: async (input) => findAmbulanceByArea(input),
});
