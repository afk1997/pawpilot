import { aliasOfToken, applyCityAliases } from "./aliases";
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
  /** When the team answers, as the directory writes it ("10am–7pm IST"); null or absent when none is published. */
  hours?: string | null;
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
 * squirrel in Marathi), "sela" (a rice), "ghorpadi disli" (Marathi घोरपडी, monitor lizards, an animal people report; Pune
 * PMC's area). Read like GENERIC_AREA_WORDS, as whole words of the area name, so an exact match through one alone needs
 * the unit's city named or known too. Curated from the seed fixture's and ambulances-clinics.csv's area names; a new area
 * name that is an everyday word belongs here. "andheri" is the one deliberate latency trade-off: Andheri is a busy Mumbai
 * suburb, so its first messages without "Mumbai" now wait for the model (which still gives the number); drop it here to
 * trade that back.
 */
export const EVERYDAY_AREA_NAMES = ["satellite", "ghuma", "ambli", "khadki", "lokhandwala", "hazra", "andheri", "khar", "sela", "ghorpadi"] as const;

const VAGUE_AREA_WORDS: ReadonlySet<string> = new Set<string>([...GENERIC_AREA_WORDS, ...EVERYDAY_AREA_NAMES]);

/**
 * Whether an area name does not pin a place down on its own: it holds a word of GENERIC_AREA_WORDS ("Model Town") or of
 * EVERYDAY_AREA_NAMES ("Satellite"), as a whole word after normalize.
 */
export function isVagueAreaName(areaName: string): boolean {
  return normalize(areaName).split(" ").some((w) => VAGUE_AREA_WORDS.has(w));
}

/**
 * Directory city names that are also everyday words: Hindi/Urdu सूरत, "surat", is a face or a look ("kutte ki surat pe
 * chot hai", "कुत्ते की सूरत पर चोट है") and, in idioms, a case or a situation ("kisi bhi surat mein", in any case). A
 * match reached only through such a name is precise only when the name reads as a place (cityCueNear) or the
 * conversation already knows that city: "surat me kutta ghayal hai" and "Adajan, Surat" name the city; "kutte ki surat
 * se khoon aa raha hai" and "kisi bhi surat mein" do not (everyday_city). One-word names, normalized; a new directory
 * city that is an everyday word belongs here.
 */
export const EVERYDAY_CITY_NAMES = ["surat"] as const;

const EVERYDAY_CITY_SET: ReadonlySet<string> = new Set<string>(EVERYDAY_CITY_NAMES);

/** A word right after the city's name that makes it a place: "surat me", "surat se", "Surat city", "सूरत में", "सूरत मे", "સુરત થી". */
const CITY_CUE_AFTER: ReadonlySet<string> = new Set([
  "me", "mein", "mai", "main", "madhe", "madhye", "ma", "maa", "se", "mathi", "city", "shehar", "में", "मे", "मध्ये", "માં", "થી", "શહેર",
]);
/**
 * An English locative right before it: "in surat", "near surat". It makes the name a place whatever stands earlier, so
 * "the dog is in surat" stays a place although English "is" is also a FACE_WORDS word (Hindi इस). Never "to", which is
 * also the Hinglish particle तो ("kutte ki to surat kharab hai").
 */
const CITY_CUE_BEFORE: ReadonlySet<string> = new Set(["in", "at", "near"]);
/**
 * Case suffixes glued to an Indic spelling of the name that make it a place: "સુરતમાં", "सूरतમાં", "सुरतमध्ये", "सुरतला"
 * (to Surat), a Marathi locative's "त". Never the Gujarati genitive "ના" (of).
 */
const CITY_CUE_SUFFIXES: ReadonlySet<string> = new Set(["माँ", "मां", "में", "मे", "मध्ये", "ात", "त", "ला", "માં", "મા", "થી"]);
/**
 * Words that, within the two words before the name (FACE_WORD_WINDOW), make it a face or part of an idiom, whatever cue
 * follows: possessives ("kutte ki surat se khoon aa raha hai", the dog's face; "उसकी सूरत में", "કૂતરા ની સૂરત") and the
 * idioms' this, that, any, every, also, such and whole ("kisi bhi surat mein", in any case; "is surat me", in this
 * situation; "ऐसी सूरत में", in such a case; "kutte ki puri surat", its whole face). Hindi and Hinglish, Gujarati and
 * Marathi, each written as a word of its own.
 */
const FACE_WORDS: ReadonlySet<string> = new Set([
  // possessives
  "ki", "ka", "ke", "uski", "iski", "की", "का", "के", "उसकी", "ની", "નો", "ના", "ची", "चा", "चे",
  // this, that, any, every, also, such, whole
  "is", "us", "kisi", "har", "bhi", "aisi", "aise", "puri", "poori", "इस", "उस", "किसी", "हर", "भी", "ऐसी", "ऐसे", "पूरी",
  "આ", "એ", "કોઈ", "દરેક", "આખી", "ही", "त्या", "कोणत्याही", "प्रत्येक", "पूर्ण",
]);
/** How many words before the name FACE_WORDS are looked for: "kutte ki puri surat me", "kisi bhi surat mein". */
const FACE_WORD_WINDOW = 2;

/** The text's words as normalize reads them, but before the aliases: NFC, lowercased, punctuation as spaces. */
function wordsOf(text: string): string[] {
  return (text ?? "")
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0);
}

/**
 * Whether `text` names the one-word city `city` as a place: one of its occurrences (in any spelling the aliases read:
 * "surat", "सूरत", "સુરત") has an English locative right before it (CITY_CUE_BEFORE: "in surat", "the dog is in surat"),
 * or, with no FACE_WORDS word within the two words before it ("kutte ki surat se khoon", "kisi bhi surat mein" are a
 * face and an idiom), is the text alone, carries a locative case suffix (CITY_CUE_SUFFIXES: "સુરતમાં"), is the last
 * word, bare ("Adajan, Surat", the "<area>, <city>" the bot asks for), or has a locative word right after it
 * (CITY_CUE_AFTER: "surat me", "सूरत मे", "Surat city").
 */
export function cityCueNear(text: string, city: string): boolean {
  const name = normalize(city);
  const words = wordsOf(text);
  return words.some((word, i) => {
    const alias = aliasOfToken(word);
    if ((alias?.name ?? word) !== name) return false;
    if (CITY_CUE_BEFORE.has(words[i - 1] ?? "")) return true;
    if (words.slice(Math.max(0, i - FACE_WORD_WINDOW), i).some((w) => FACE_WORDS.has(w))) return false;
    if (words.length === 1 || (alias?.suffix != null && CITY_CUE_SUFFIXES.has(alias.suffix))) return true;
    if (i === words.length - 1 && alias?.suffix == null) return true;
    return CITY_CUE_AFTER.has(words[i + 1] ?? "");
  });
}

/** Why an exact match on the reporter's words alone is not precise enough to act on without the model. */
export type PrecisionIssue = "other_city" | "generic_area" | "everyday_city";

/**
 * The precision rules for an exact match (`result`) made on the reporter's words alone (`text`, the query it was made
 * on), which the fast path's card and the Claude turn's pre-match both follow: other_city when the text names a
 * directory city (citiesNamed) that is not every matched unit's ("Ghatkopar, Pune"); generic_area when an area match
 * reaches a unit only through vague area names (isVagueAreaName: a GENERIC_AREA_WORDS or EVERYDAY_AREA_NAMES word, found
 * by areaNamesIn) and the text does not name that unit's city ("Model Town, Ludhiana", "ambli na jhad pase");
 * everyday_city when a city match, or an area match whose area names are all such a city's, reaches a unit only through
 * a name of EVERYDAY_CITY_NAMES that does not read as a place (cityCueNear: "kutte ki surat pe chot hai", "kutte ki
 * surat se khoon aa raha hai", "kisi bhi surat mein", while "surat me kutta ghayal hai", "surat se hun", "Adajan,
 * Surat", "Surat" alone and "સુરતમાં" are precise). A unit reached through a plain name too ("South Bopal" also names Bopal) is
 * precise. Null when none holds: "ghatkopar" and "Karve Nagar, Pune" are precise. Pure: rows in, issue out.
 *
 * `knownCity` (the pre-match only; the fast path answers before any city is known): the city the conversation already
 * holds stands until the words name another, so a unit in a different city whose city the text does not name is
 * other_city ("gaadi ghuma rahe the" after Mumbai is known is not Ahmedabad's Ghuma), and a known city equal to the
 * unit's counts as named for generic_area ("Karve Nagar me" once Pune is known) and for everyday_city. It is not one of
 * citiesNamed's: a text naming a new covered city ("sorry, it is in surat") is still precise.
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
  // The names a unit was reached through: its city for a city match, the area names the text names for an area match.
  const reachedThrough = (u: DirectoryAmbulance) => (result.match === "city" ? [u.city] : result.match === "area" ? areaNamesIn(u, text) : []);
  const everyday = (u: DirectoryAmbulance) => {
    if (normalize(u.city) === known) return false;
    const names = reachedThrough(u);
    return names.length > 0 && names.every((n) => EVERYDAY_CITY_SET.has(normalize(n))) && !names.some((n) => cityCueNear(text, n));
  };
  if (result.candidates.some(everyday)) return "everyday_city";
  return null;
}

/** Devanagari and Gujarati nukta: "ग़लत" is read as "गलत". */
const NUKTA_RE = /[़઼]/g;

/** Apostrophes a keyboard may send for "'": a phone's smart punctuation writes "didn’t". */
const APOSTROPHE_RE = /[\u2018\u2019\u02BC\u0060\u00B4]/g;

/** Latin spellings of "nahi" a phone keyboard produces, read as "nahi" (whole words only, so a place word is never touched). */
const NAHI_RE = /(?<![\p{L}\p{M}\p{N}])(?:nahin|nhi|nai|nahee|nahii)(?![\p{L}\p{M}\p{N}])/giu;

/**
 * The form both listed words and the reporter's text are read in: NFC, no nukta ("लड़का" and "लडका" are one word), every
 * apostrophe as "'" ("didn’t" is "didn't"), every whitespace run as one space, so a phrase's space matches a line break
 * or a double space too, and "nahi"'s keyboard spellings as "nahi".
 */
const listedForm = (s: string) =>
  s.normalize("NFC").replace(NUKTA_RE, "").replace(APOSTROPHE_RE, "'").replace(/\s+/g, " ").replace(NAHI_RE, "nahi");

/** An entry as a literal in the pattern: a regex character in it ("switch-off" has none today) never acts as one. */
const literal = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A test for whether a text holds one of `entries` at the start of a word, in any case, whatever ending follows, both read
 * in the same form (listedForm): "Clinics", "दवाखाना", "દવાખાનું" and "ખોટો" count; "vardaan" and "वरदान" do not. The
 * fast path's OTHER_INTENT_WORDS and the pre-match's FACILITY_WORDS are read with it.
 */
export function listedWordFinder(entries: readonly string[]): (text: string) => boolean {
  const re = new RegExp(`(?<![\\p{L}\\p{M}\\p{N}])(?:${entries.map((w) => literal(listedForm(w))).join("|")})`, "iu");
  return (text) => re.test(listedForm(text));
}

/**
 * Words for a clinic, a hospital or a doctor, in Latin script (English and Hinglish), Devanagari (Hindi and Marathi) and
 * Gujarati, read by listedWordFinder. A burst holding one asks for a facility: the fast path leaves it to the model (the
 * words open OTHER_INTENT_WORDS in src/server/worker/fast-path.ts) and the pre-match offers no ambulance for it.
 */
export const FACILITY_WORDS = [
  "clinic", "clinik", "hospital", "doctor", "dawakhana", "क्लिनिक", "दवाखाना", "अस्पताल", "हॉस्पिटल", "डॉक्टर", "डाक्टर",
  "દવાખાન", "ક્લિનિક", "હોસ્પિટલ", "ડૉક્ટર", "ડોક્ટર",
] as const;

/** Whether the text holds a word of FACILITY_WORDS ("ghatkopar hospital ka number", "दवाखाना कहाँ है"). */
export const hasFacilityWord = listedWordFinder(FACILITY_WORDS);

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
