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

/**
 * Street, direction and locality words too generic to drive the loose tiers
 * (3–5). Tiers 4 and 5 drop them, and tier 3 runs only if a non-generic word
 * of 4+ letters remains, so "Station Road" does not match "Mira Road", "Pant
 * Nagar" does not match "Tilak Nagar", and a bare "Nagar" or "Road" matches
 * nothing.
 */
const GENERIC_TOKENS: ReadonlySet<string> = new Set([
  "road", "east", "west", "north", "south", "near", "station", "main", "area", "city", "marg", "lane", "cross",
  "nagar", "colony", "park", "market", "village", "chowk", "circle",
]);

/**
 * Tier 5 compares only words at least this long, on both sides: shorter words
 * are one edit apart too often ("madad" ≈ "malad", "ghar" ≈ "khar").
 */
const FUZZY_MIN_LENGTH = 6;

/**
 * Tier 4 lets a token match the start of a place word only with this many
 * letters: "kandi" finds Kandivali, but "band" (closed) does not find Bandra.
 */
const PREFIX_MIN_LENGTH = 5;

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

/** Tier 1 — area exact: row.area or any areas_covered equals the needle or one of its tokens. */
function areaExact(pool: DirectoryAmbulance[], needle: string): DirectoryAmbulance[] {
  const toks = tokensOf(needle);
  return pool.filter((r) => {
    const areas = [r.area ?? "", ...r.areasCovered].map(normalize).filter(Boolean);
    return areas.some((a) => a === needle || toks.includes(a));
  });
}

/**
 * Neighbour-map keys for a needle: each word, each adjacent word pair
 * ("vile parle") and, when it has at most three words, the needle itself.
 * Keys match exactly, so a word that contains a key ("kharab") finds nothing.
 */
function neighbourKeys(needle: string): Set<string> {
  const words = needle.split(" ");
  const keys = new Set(words);
  for (let i = 0; i + 1 < words.length; i++) keys.add(`${words[i]} ${words[i + 1]}`);
  if (words.length <= 3) keys.add(needle);
  return keys;
}

/**
 * Tiers 2–6 for one needle: city exact → substring → token → fuzzy →
 * neighbour. The first non-empty tier wins; null when all five are empty.
 * No tier searches the label: a label word ("Rajkot - Hope") is not a place.
 */
function broaderMatch(pool: DirectoryAmbulance[], needle: string): MatchResult | null {
  const toks = tokensOf(needle);
  const looseToks = toks.filter((t) => !GENERIC_TOKENS.has(t));
  let hit: DirectoryAmbulance[];

  // Tier 2 — city exact (whole needle or a single token equals the city).
  hit = pool.filter((r) => {
    const c = normalize(r.city);
    return c === needle || toks.includes(c);
  });
  if (hit.length > 0) return finish(hit, "city");

  // Tier 3 — substring (whole needle inside city/area/areas_covered). Skipped
  // without a loose token, so a bare generic word ("Nagar", "Road") finds nothing.
  if (looseToks.length > 0) {
    hit = pool.filter((r) =>
      [r.city, r.area ?? "", ...r.areasCovered].map(normalize).some((h) => h.length >= 4 && h.includes(needle))
    );
    if (hit.length > 0) return finish(hit, "substring");
  }

  // Tier 4 — a token equals a whole place word or starts one (PREFIX_MIN_LENGTH),
  // generic words dropped. A word inside a name ("gali" in Bengali Square) is no match.
  hit = pool.filter((r) =>
    [r.city, r.area ?? "", ...r.areasCovered]
      .map(normalize)
      .some((h) => h.split(" ").some((w) => looseToks.some((t) => w === t || (t.length >= PREFIX_MIN_LENGTH && w.startsWith(t)))))
  );
  if (hit.length > 0) return finish(hit, "token");

  // Tier 5 — fuzzy token vs city/area, generic words dropped, FUZZY_MIN_LENGTH on both sides.
  const fuzzyToks = looseToks.filter((t) => t.length >= FUZZY_MIN_LENGTH);
  hit = pool.filter((r) => {
    const hay = [r.city, r.area ?? "", ...r.areasCovered].map(normalize).filter((h) => h.length >= FUZZY_MIN_LENGTH);
    return fuzzyToks.some((t) => hay.some((h) => fuzzyEqual(t, h)));
  });
  if (hit.length > 0) return finish(hit, "fuzzy");

  // Tier 6 — neighbour map on exact keys (neighbourKeys). Every covered
  // neighbour counts (Goregaon → Malad and Andheri), not only the first one.
  const neighbours = new Set<string>();
  for (const k of neighbourKeys(needle)) for (const n of neighborCandidates(k)) neighbours.add(normalize(n));
  hit = pool.filter((r) => {
    const hay = [r.area ?? "", ...r.areasCovered, r.city].map(normalize);
    return [...neighbours].some((nn) => hay.some((h) => h === nn || (nn.length >= 4 && h.includes(nn))));
  });
  if (hit.length > 0) return finish(hit, "neighbour");

  return null;
}

/**
 * `city` restricts the row set first. Tier 1 (exact area) then runs for the
 * `area` needle and then the free-text `query`, so an exact area named in
 * either beats any looser match. Only then do tiers 2–6 run, area needle
 * first, so a city named in the reporter's words cannot pre-empt the area's
 * own fuzzy or neighbour match ("Goregaon, Mumbai" → Malad/Andheri). If a
 * row's city equals `city` exactly (after aliasing) and no tier matched either
 * needle, the restricted rows are returned as a `city` match. A city only
 * similar to a covered one (Nagaur ≈ Nagpur) still narrows the tiers but never
 * falls back: that is out of coverage, as is a search no city narrowed.
 */
export function matchAmbulances(rows: DirectoryAmbulance[], input: MatchInput): MatchResult {
  const q = normalize(input.query);
  const wantedCity = input.city ? normalize(input.city) : "";
  const wantedArea = input.area ? normalize(input.area) : "";

  const cityRows = wantedCity ? rows.filter((r) => cityMatches(r.city, wantedCity)) : [];
  const pool = cityRows.length > 0 ? cityRows : rows;
  const cityCovered = cityRows.some((r) => normalize(r.city) === wantedCity);

  const needles = [wantedArea, q].filter((n) => n.length > 0);
  for (const needle of needles) {
    const hit = areaExact(pool, needle);
    if (hit.length > 0) return finish(hit, "area");
  }
  for (const needle of needles) {
    const result = broaderMatch(pool, needle);
    if (result) return result;
  }

  // A covered city with no place we recognise: offer the whole city (city_areas
  // lets the model ask for the area) instead of calling it out of coverage.
  if (cityCovered) return finish(cityRows, "city");

  return { candidates: [], match: null, cityAreas: null, outOfCoverage: true };
}
