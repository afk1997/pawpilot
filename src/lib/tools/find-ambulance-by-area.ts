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
    .describe("Reporter's language; helps with logging only, no behavior change."),
});

export type FindAmbulanceByAreaInput = z.infer<typeof findAmbulanceByAreaParams>;

export interface AmbulanceRow {
  id: string;
  label: string;
  driver_phone: string;
  city: string;
  area: string | null;
  state: string;
  areas_covered: string[];
  category: string;
  operator_name: string;
  operator_is_arham: boolean;
}

/** Normalize a string for fuzzy matching: lowercase, strip non-alphanum. */
function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
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

  const rows: AmbulanceRow[] = data.map((r) => {
    const op = (r as unknown as { ngo_operators?: { name?: string; is_arham?: boolean } })
      .ngo_operators;
    return {
      id: r.id as string,
      label: r.label as string,
      driver_phone: r.phone as string,
      city: r.city as string,
      area: (r.area as string | null) ?? null,
      state: r.state as string,
      areas_covered: (r.areas_covered as string[]) ?? [],
      category: r.category as string,
      operator_name: op?.name ?? "Arham Yuva Seva Group",
      operator_is_arham: op?.is_arham ?? true,
    };
  });

  const tokens = q.split(" ").filter((t) => t.length >= 3);

  // Tier 1 — city exact match.
  const cityMatches = rows.filter((r) => norm(r.city) === q || tokens.includes(norm(r.city)));
  if (cityMatches.length > 0) return cityMatches;

  // Tier 2 — area exact match.
  const areaExact = rows.filter(
    (r) =>
      (r.area && norm(r.area) === q) ||
      r.areas_covered.some((a) => norm(a) === q || tokens.includes(norm(a)))
  );
  if (areaExact.length > 0) return areaExact;

  // Tier 3 — substring match in label/city/area/areas_covered.
  const substring = rows.filter((r) => {
    const haystack = [r.label, r.city, r.area ?? "", ...r.areas_covered].map(norm);
    return haystack.some((h) => h.includes(q) || q.includes(h)) ||
      tokens.some((t) => haystack.some((h) => h.includes(t)));
  });
  if (substring.length > 0) return substring;

  return [];
}

export const findAmbulanceByAreaTool = tool({
  description:
    "Find ambulance(s) covering the reporter's location. Returns 0+ rows with driver name, phone, areas covered, and operator. If multiple rows match, the orchestrator may follow up with get_nearest_ambulance.",
  inputSchema: findAmbulanceByAreaParams,
  execute: async (input) => findAmbulanceByArea(input),
});
