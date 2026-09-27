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
 * Tier 5 compares only reporter words at least this long, since shorter words are one edit apart too often ("madad" ≈
 * "malad", "ghar" ≈ "khar"), against place names at least FUZZY_PLACE_MIN_LENGTH long, so a six-letter misspelling
 * still finds a five-letter place ("suratt" → Surat, "malaad" → Malad).
 */
const FUZZY_TOKEN_MIN_LENGTH = 6;
const FUZZY_PLACE_MIN_LENGTH = 5;

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

/**
 * Tier 1's test for one needle: a normalized area name equals the needle, one of its tokens or two adjacent words of it
 * ("vile parle" in "dog hurt near vile parle station").
 */
function namedBy(needle: string): (area: string) => boolean {
  const toks = tokensOf(needle);
  const words = needle.split(" ");
  const pairs = words.slice(1).map((w, i) => `${words[i]} ${w}`);
  return (a) => a === needle || toks.includes(a) || pairs.includes(a);
}

/** Tier 1 — area exact: row.area or any areas_covered is named by the needle (namedBy). */
function areaExact(pool: DirectoryAmbulance[], needle: string): DirectoryAmbulance[] {
  const named = namedBy(needle);
  return pool.filter((r) => [r.area ?? "", ...r.areasCovered].map(normalize).filter(Boolean).some(named));
}

/**
 * The row's area names (its area, then its areas_covered, as the directory spells them, each once) that `text` names
 * as tier 1 reads it: the whole text, one of its tokens or two adjacent words, after normalize. For an exact area
 * match, the names it went through ("Vikhroli" for a unit whose area is Ghatkopar).
 */
export function areaNamesIn(row: Pick<DirectoryAmbulance, "area" | "areasCovered">, text: string): string[] {
  const needle = normalize(text);
  if (needle.length === 0) return [];
  const named = namedBy(needle);
  return [...new Set([row.area ?? "", ...row.areasCovered])].filter((a) => {
    const n = normalize(a);
    return n.length > 0 && named(n);
  });
}

/** Whether `name`, normalized, is the normalized `text` or a run of its words ("navi mumbai" in "dog hurt in navi mumbai"). */
export function textNames(text: string, name: string): boolean {
  const n = normalize(name);
  return n.length > 0 && ` ${normalize(text)} `.includes(` ${n} `);
}

/**
 * The directory's cities `text` names, each once, as the rows spell them: a city whose name, normalized as the city
 * tier reads it (aliases applied, so Bangalore is Bengaluru and मुंबई or મુંબઈ is Mumbai), is the whole text or a run
 * of its words (textNames: one word, or a pair such as "navi mumbai"). A city inside a longer one ("mumbai" in "navi
 * mumbai") counts as named too.
 */
export function citiesNamed(rows: DirectoryAmbulance[], text: string): string[] {
  const hay = ` ${normalize(text)} `;
  const found = new Map<string, string>();
  for (const r of rows) {
    const c = normalize(r.city);
    if (c.length > 0 && !found.has(c) && hay.includes(` ${c} `)) found.set(c, r.city);
  }
  return [...found.values()];
}

/**
 * Locality words so common that an area name holding one ("Model Town", "Vijay Nagar", "Mira Road") names a place in
 * many cities: an exact area match that goes only through such names is not precise unless the text also names the
 * unit's city (precisionIssue). A whole word of the area name, in any case. Not GENERIC_TOKENS, which keeps generic
 * words from driving the loose tiers. The directory's area names are all in Latin script (the seed fixture's and
 * ambulances-clinics.csv's alike), so the list is too; an Indic area name added to the directory needs its locality
 * words here.
 */
export const GENERIC_AREA_WORDS = [
  "nagar", "town", "colony", "road", "park", "garden", "vihar", "puram", "gunj", "ganj", "chowk", "market", "marg", "gali",
  "society", "sector", "phase", "block", "layout", "extension", "enclave", "camp", "lines", "bazaar", "bazar", "basti",
  "model", "new", "old", "east", "west", "north", "south", "central",
] as const;

const GENERIC_AREA_SET: ReadonlySet<string> = new Set(GENERIC_AREA_WORDS);

/** Whether an area name holds a word of GENERIC_AREA_WORDS, as a whole word after normalize. */
export function hasGenericAreaWord(areaName: string): boolean {
  return normalize(areaName).split(" ").some((w) => GENERIC_AREA_SET.has(w));
}

/**
 * Area names that are also everyday words, verb forms or surnames in English, Hindi, Marathi or Gujarati, so a message
 * can hold one without naming the place: "ambli na jhad pase" (a tamarind tree), "gaadi ghuma rahe the" (turning), "khadki
 * pase" (a lane's gate), "Hazra ji ka kutta" and "Lokhandwala ji" (surnames), "andheri raat" (a dark night), "khar" (a
 * squirrel in Marathi), "sela" (a rice). Read like GENERIC_AREA_WORDS, as whole words of the area name, so an exact
 * match through one alone needs the unit's city named or known too. Curated from the seed fixture's and
 * ambulances-clinics.csv's area names; a new area name that is an everyday word belongs here.
 */
export const EVERYDAY_AREA_NAMES = ["satellite", "ghuma", "ambli", "khadki", "lokhandwala", "hazra", "andheri", "khar", "sela"] as const;

const VAGUE_AREA_WORDS: ReadonlySet<string> = new Set<string>([...GENERIC_AREA_WORDS, ...EVERYDAY_AREA_NAMES]);

/**
 * Whether an area name does not pin a place down on its own: it holds a word of GENERIC_AREA_WORDS ("Model Town") or of
 * EVERYDAY_AREA_NAMES ("Satellite"), as a whole word after normalize.
 */
export function isVagueAreaName(areaName: string): boolean {
  return normalize(areaName).split(" ").some((w) => VAGUE_AREA_WORDS.has(w));
}

/** Why an exact match on the reporter's words alone is not precise enough to act on without the model. */
export type PrecisionIssue = "other_city" | "generic_area";

/**
 * The precision rules for an exact match (`result`) made on the reporter's words alone (`text`, the query it was made
 * on), which the fast path's card and the Claude turn's pre-match both follow: other_city when the text names a
 * directory city (citiesNamed) that is not every matched unit's ("Ghatkopar, Pune"); generic_area when an area match
 * reaches a unit only through vague area names (isVagueAreaName: a GENERIC_AREA_WORDS or EVERYDAY_AREA_NAMES word, found
 * by areaNamesIn) and the text does not name that unit's city ("Model Town, Ludhiana", "ambli na jhad pase"). A unit
 * reached through a plain name too ("South Bopal" also names Bopal) is precise. Null when neither holds: "ghatkopar"
 * and "Karve Nagar, Pune" are precise. Pure: rows in, issue out.
 *
 * `knownCity` (the pre-match only; the fast path answers before any city is known): the city the conversation already
 * holds stands until the words name another, so a unit in a different city whose city the text does not name is
 * other_city ("gaadi ghuma rahe the" after Mumbai is known is not Ahmedabad's Ghuma), and a known city equal to the
 * unit's counts as named for generic_area ("Karve Nagar me" once Pune is known). It is not one of citiesNamed's: a text
 * naming a new covered city ("sorry, it is in surat") is still precise.
 */
export function precisionIssue(
  rows: DirectoryAmbulance[],
  text: string,
  result: Pick<MatchResult, "match" | "candidates">,
  context: { knownCity?: string | null } = {}
): PrecisionIssue | null {
  const named = citiesNamed(rows, text).map(normalize);
  if (named.some((c) => result.candidates.some((u) => normalize(u.city) !== c))) return "other_city";
  const known = context.knownCity ? normalize(context.knownCity) : "";
  if (known.length > 0 && result.candidates.some((u) => normalize(u.city) !== known && !textNames(text, u.city))) return "other_city";
  const cityGiven = (u: DirectoryAmbulance) => named.includes(normalize(u.city)) || normalize(u.city) === known;
  const vague = (u: DirectoryAmbulance) => !cityGiven(u) && areaNamesIn(u, text).every(isVagueAreaName);
  if (result.match === "area" && result.candidates.some(vague)) return "generic_area";
  return null;
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

  // Tier 5 — fuzzy token vs city/area, generic words dropped, FUZZY_TOKEN_MIN_LENGTH and FUZZY_PLACE_MIN_LENGTH.
  const fuzzyToks = looseToks.filter((t) => t.length >= FUZZY_TOKEN_MIN_LENGTH);
  hit = pool.filter((r) => {
    const hay = [r.city, r.area ?? "", ...r.areasCovered].map(normalize).filter((h) => h.length >= FUZZY_PLACE_MIN_LENGTH);
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
