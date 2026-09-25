/**
 * The last code guards on a reply before it is sent (spec §5.9 steps 3 and 5). The digit scrubber finds phone-shaped
 * runs the model typed, as opposed to numbers code inserted for tokens; the dispatch guard finds and replaces sentences
 * that say Arham is sending an ambulance. Every function first reads its text through normalizeDigits, so native
 * numerals, invisible characters and unusual separators cannot hide a number; text it returns is in that form.
 */

/** A phone-shaped run: 7+ digits, an optional leading "+", at most one space, line break or "-" between two digits. */
export const DIGIT_RUN_RE = /\+?\d(?:[\s-]?\d){6,}/g;
/** The fewest digits a DIGIT_RUN_RE match holds. */
const MIN_RUN_DIGITS = 7;

const DECIMAL_DIGIT = /\p{Nd}/u;

/**
 * The value of a decimal digit in any script. Unicode encodes every decimal digit set as a contiguous 0–9 run, so the
 * value is the distance from the start of the run (mod 10 where sets sit back to back, as the math digits do). Mirrors
 * tools.ts, which this module does not import: it stays free of the SDK and the database.
 */
function digitValue(ch: string): number {
  const cp = ch.codePointAt(0) as number;
  let start = cp;
  while (start > 0 && DECIMAL_DIGIT.test(String.fromCodePoint(start - 1))) start--;
  return (cp - start) % 10;
}

/**
 * The form every function here reads: every decimal digit as ASCII (Devanagari, Gujarati, Bengali, fullwidth, …);
 * invisible characters dropped (soft hyphen, zero-width space, word joiner, and zero-width (non-)joiners next to a
 * digit); and between two digits, any run of spaces (NBSP, narrow NBSP, tab, …) as one space and any dash variant as
 * "-". Separators change only between digits, so prose keeps its dashes, indentation and line breaks.
 */
function normalizeDigits(s: string): string {
  return s
    .replace(/\p{Nd}/gu, (ch) => (ch <= "9" ? ch : String(digitValue(ch))))
    .replace(/[\u00AD\u200B\u2060]/g, "")
    .replace(/(?<=\d)[\u200C\u200D]+|[\u200C\u200D]+(?=\d)/g, "")
    .replace(/(?<=\d)[^\S\n]+(?=\d)/g, " ")
    .replace(/(?<=\d)[\u2010-\u2015\u2212\uFE63\uFF0D](?=\d)/g, "-");
}

/**
 * Every run in normalized text, read with a fresh copy of DIGIT_RUN_RE: matchAll starts at the regex's lastIndex,
 * which a caller's exec on the export can leave advanced.
 */
function runsIn(normalized: string): string[] {
  return Array.from(normalized.matchAll(new RegExp(DIGIT_RUN_RE)), (m) => m[0]);
}

export function findDigitRuns(text: string): string[] {
  return runsIn(normalizeDigits(text));
}

export function digitsOf(run: string): string {
  return normalizeDigits(run).replace(/\D/g, "");
}

/** One optional separator between two digits, as DIGIT_RUN_RE reads them. */
const SEP = "[\\s-]?";

/**
 * A pattern for every written form of one allowed number: an optional "+", an optional separator between any two
 * digits, and for an Indian number (10 digits, or 12 starting with 91) an optional 91 country code, so
 * "+91 70000 00001", "91-70000-00001" and "7000000001" are all the same number.
 */
function numberPattern(digits: string): string {
  const local = digits.length === 12 && digits.startsWith("91") ? digits.slice(2) : digits;
  return local.length === 10
    ? `(?:\\+?9${SEP}1${SEP})?${local.split("").join(SEP)}`
    : `\\+?${digits.split("").join(SEP)}`;
}

/**
 * Splits normalized text into [free, allowed, free, allowed, …, free]: odd indices hold allowed numbers, which are
 * never read as runs or edited, so digits next to an inserted number cannot merge with it into one run. A form glued
 * to another digit or a "+" is not allowed: it reads as part of a foreign run, so a corrupted number is never sent.
 * Allowed numbers shorter than a run are skipped; they can never be a run, and masking them could split a foreign one.
 */
function splitAllowed(normalized: string, allowedNumbers: string[]): string[] {
  const digits = allowedNumbers.map(digitsOf).filter((d) => d.length >= MIN_RUN_DIGITS);
  const patterns = [...new Set(digits.sort((a, b) => b.length - a.length).map(numberPattern))];
  if (patterns.length === 0) return [normalized];
  return normalized.split(new RegExp(`(?<![\\d+])(${patterns.join("|")})(?!\\d)`));
}

/** Runs that are not one of the allowed numbers (formatted, with or without the country code, in any script). */
export function foreignDigitRuns(text: string, allowedNumbers: string[]): string[] {
  return splitAllowed(normalizeDigits(text), allowedNumbers)
    .filter((_, i) => i % 2 === 0)
    .flatMap((part) => runsIn(part));
}

/**
 * Removes every occurrence of the runs, then the doubled space or the space before punctuation a removal leaves.
 * Pass the allowed list given to foreignDigitRuns: allowed numbers are then left whole even where a run's text occurs
 * inside one. Longer runs go first, so a run nested in a longer one cannot leave the longer one's remainder behind.
 */
export function stripRuns(text: string, runs: string[], allowedNumbers: string[] = []): string {
  const targets = [...new Set(runs.map(normalizeDigits))].filter((r) => r !== "").sort((a, b) => b.length - a.length);
  return splitAllowed(normalizeDigits(text), allowedNumbers)
    .map((part, i) => (i % 2 === 1 ? part : targets.reduce((out, run) => out.split(run).join(""), part)))
    .join("")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ +([.,!?।])/g, "$1")
    .trim();
}

/** "we're" also with a typographic apostrophe (U+2019). */
export const DISPATCH_RE = /we(?:['\u2019]| a)?re sending|on (?:the|their|its) way|dispatch(?:ed|ing)?\b|भेज रहे|पाठवत आहोत|મોકલી રહ્યા/i;

export function hasDispatchLanguage(text: string): boolean {
  return DISPATCH_RE.test(normalizeDigits(text));
}

/**
 * A sentence with its terminators (., !, ?, ।) and the whitespace after it, a stray run of terminators, or line
 * breaks. Every character lands in one part, so no text is lost when the parts are joined again.
 */
const SENTENCE_RE = /[^.!?।\n]+[.!?।]*\s*|[.!?।]+\s*|\n+/g;

/** Replaces each sentence that matches DISPATCH_RE, keeping the whitespace after it, so paragraph breaks survive. */
export function replaceDispatchSentences(text: string, replacement: string): string {
  const normalized = normalizeDigits(text);
  const parts = normalized.match(SENTENCE_RE) ?? [normalized];
  return parts
    .map((p) => (DISPATCH_RE.test(p) ? replacement + p.slice(p.trimEnd().length) : p))
    .join("")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}
