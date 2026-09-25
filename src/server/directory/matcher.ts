import { applyCityAliases } from "./aliases";
import { fuzzyEqual } from "./fuzzy";
import { neighborCandidates } from "./neighbors";

export interface DirectoryAmbulance {
  id: string;
  label: string;
  city: string;
  area: string | null;
  state: string;
  areasCovered: string[];
  category: string;
  phone: string;
  operatorName: string;
  operatorIsArham: boolean;
}

export type MatchType = "area" | "city" | "substring" | "token" | "fuzzy" | "neighbour";

export interface MatchResult {
  candidates: DirectoryAmbulance[];
  match: MatchType | null;
  /** Distinct areas when a city matched with more than three units, so the model can ask. */
  cityAreas: string[] | null;
  outOfCoverage: boolean;
}

export interface MatchInput {
  city?: string | null;
  area?: string | null;
  query: string;
}

/** Lowercase, strip punctuation, collapse spaces, apply city aliases (Latin + Indic). */
export function normalize(s: string): string {
  return applyCityAliases(
    (s ?? "")
      // NFC so reporter text matches the NFC alias keys (e.g. a precomposed nukta letter).
      .normalize("NFC")
      .toLowerCase()
      // Keep \p{M}: Indic vowel signs, anusvara and virama are marks, not letters.
      .replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

const tokensOf = (q: string) => q.split(" ").filter((t) => t.length >= 4);

function cityMatches(rowCity: string, wanted: string): boolean {
  const c = normalize(rowCity);
  if (c === wanted) return true;
  return fuzzyEqual(c, wanted);
}

function finish(candidates: DirectoryAmbulance[], match: MatchType): MatchResult {
  const sorted = [...candidates].sort((a, b) => a.label.localeCompare(b.label));
  let cityAreas: string[] | null = null;
  if (sorted.length > 3) {
    const areas = Array.from(new Set(sorted.map((r) => r.area).filter((a): a is string => !!a))).sort();
    if (areas.length > 0) cityAreas = areas;
  }
  return { candidates: sorted, match, cityAreas, outOfCoverage: false };
}

/**
 * Tiered lookup for one needle: area exact → city exact → substring → token →
 * fuzzy → neighbour. The first non-empty tier wins; null when all six are empty.
 */
function matchNeedle(pool: DirectoryAmbulance[], needle: string): MatchResult | null {
  const toks = tokensOf(needle);
  let hit: DirectoryAmbulance[];

  // Tier 1 — area exact (row.area or any areas_covered equals the needle or one of its tokens).
  hit = pool.filter((r) => {
    const areas = [r.area ?? "", ...r.areasCovered].map(normalize).filter(Boolean);
    return areas.some((a) => a === needle || toks.includes(a));
  });
  if (hit.length > 0) return finish(hit, "area");

  // Tier 2 — city exact (whole needle or a single token equals the city).
  hit = pool.filter((r) => {
    const c = normalize(r.city);
    return c === needle || toks.includes(c);
  });
  if (hit.length > 0) return finish(hit, "city");

  // Tier 3 — substring (needle inside label/city/area/areas_covered).
  if (needle.length >= 4) {
    hit = pool.filter((r) =>
      [r.label, r.city, r.area ?? "", ...r.areasCovered].map(normalize).some((h) => h.length >= 4 && h.includes(needle))
    );
    if (hit.length > 0) return finish(hit, "substring");
  }

  // Tier 4 — token containment.
  hit = pool.filter((r) =>
    [r.label, r.city, r.area ?? "", ...r.areasCovered].map(normalize).some((h) => toks.some((t) => h === t || h.includes(t)))
  );
  if (hit.length > 0) return finish(hit, "token");

  // Tier 5 — fuzzy token vs city/area.
  hit = pool.filter((r) => {
    const hay = [r.city, r.area ?? "", ...r.areasCovered].map(normalize).filter((h) => h.length >= 4);
    return toks.some((t) => hay.some((h) => fuzzyEqual(t, h)));
  });
  if (hit.length > 0) return finish(hit, "fuzzy");

  // Tier 6 — neighbour map, on the whole needle and each token. Every covered
  // neighbour counts (Goregaon → Malad and Andheri), not only the first one.
  const neighbours = new Set<string>();
  for (const k of [needle, ...toks]) for (const n of neighborCandidates(k)) neighbours.add(normalize(n));
  hit = pool.filter((r) => {
    const hay = [r.area ?? "", ...r.areasCovered, r.city].map(normalize);
    return [...neighbours].some((nn) => hay.some((h) => h === nn || (nn.length >= 4 && h.includes(nn))));
  });
  if (hit.length > 0) return finish(hit, "neighbour");

  return null;
}

/**
 * `city` restricts the row set first. The `area` needle then runs through all
 * six tiers before the free-text `query` does, so a city named in the
 * reporter's words cannot pre-empt the area's own fuzzy or neighbour match
 * ("Goregaon, Mumbai" → Malad/Andheri, not every Mumbai unit).
 */
export function matchAmbulances(rows: DirectoryAmbulance[], input: MatchInput): MatchResult {
  const q = normalize(input.query);
  const wantedCity = input.city ? normalize(input.city) : "";
  const wantedArea = input.area ? normalize(input.area) : "";

  let pool = rows;
  if (wantedCity) {
    const restricted = rows.filter((r) => cityMatches(r.city, wantedCity));
    if (restricted.length > 0) pool = restricted;
  }

  const needles = [wantedArea, q].filter((n) => n.length > 0);
  for (const needle of needles) {
    const result = matchNeedle(pool, needle);
    if (result) return result;
  }

  return { candidates: [], match: null, cityAreas: null, outOfCoverage: true };
}
