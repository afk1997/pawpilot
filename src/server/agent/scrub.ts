/**
 * The last code guards on a reply before it is sent (spec §5.9 steps 3 and 5). The digit scrubber finds phone-shaped
 * runs the model typed, as opposed to numbers code inserted for tokens; the dispatch guard finds and replaces sentences
 * that say Arham is sending an ambulance. Every function first reads its text through normalizeDigits, so native
 * numerals, invisible characters and unusual separators cannot hide a number; text it returns is in that form.
 */

/**
 * A phone-shaped run: 7+ digits, an optional leading "+", at most one space, line break or "-" between two digits.
 *
 * Known residuals, each read as short groups and so never as a run: groups joined by a dot, slash, comma or spaced
 * hyphen ("98765.43210", "98765/43210", "98,765,43,210", "98765 - 43210"); a parenthesised group ("(98765) 43210");
 * the letter O written for a zero ("98765 432O0"); words between the groups ("98765 then 43210"); and a number split
 * across sentences or lines ("98765. 43210", "98765 \n43210", "98765\n\n43210").
 */
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

/** Collapses a run of spaces or tabs that follows a non-space character, so a line's indent (a card's) survives. */
function collapseSpaces(s: string): string {
  return s.replace(/(?<=\S)[ \t]{2,}/g, " ");
}

/**
 * Removes every occurrence of the runs, then the doubled space or the space before punctuation a removal leaves.
 * Pass the allowed list given to foreignDigitRuns: allowed numbers are then left whole even where a run's text occurs
 * inside one. Longer runs go first, so a run nested in a longer one cannot leave the longer one's remainder behind.
 */
export function stripRuns(text: string, runs: string[], allowedNumbers: string[]): string {
  const targets = [...new Set(runs.map(normalizeDigits))].filter((r) => r !== "").sort((a, b) => b.length - a.length);
  const stripped = splitAllowed(normalizeDigits(text), allowedNumbers)
    .map((part, i) => (i % 2 === 1 ? part : targets.reduce((out, run) => out.split(run).join(""), part)))
    .join("");
  return collapseSpaces(stripped).replace(/ +([.,!?।])/g, "$1").trim();
}

// Building blocks of DISPATCH_RE. JS's \b only knows ASCII letters, so word edges in Indic scripts are spelled out.
/** Horizontal whitespace between two words. Never a line break: a line break ends a sentence here. */
const GAP = String.raw`[^\S\n]+`;
const WORD_START = String.raw`(?<![\p{L}\p{M}\p{Nd}])`;
const WORD_END = String.raw`(?![\p{L}\p{M}\p{Nd}])`;
/** Titles whose dot never ends a sentence ("Dr. Shah"). */
const TITLE = String.raw`\b(?:Dr|Mr|Mrs|Ms|Smt|Shri|Prof)`;
/**
 * A sentence end: a danda anywhere, or ".", "!" or "?" followed (after any further terminators) by whitespace or the
 * end of the text, so the dot in a URL ("arhamalwayscare.org/help") or after a title ("Dr. Shah") ends nothing.
 */
const TERMINATOR = String.raw`(?:।|(?<!${TITLE})[.!?](?=[.!?।]*(?:\s|$)))`;
/** Any text up to the end of the current sentence (SENTENCE_RE splits at the same places). */
const SAME_SENTENCE = String.raw`(?:(?!${TERMINATOR})[^\n])*?`;
const FIRST_PERSON = String.raw`(?:we|I|हम|हमने|मैं|मैंने|आम्ही|मी|અમે|મેં|હું)`;
/** An ambulance, vehicle or crew, in every script; गाड़ी with ड़ in either encoding, or as Marathi's गाडी. */
const VEHICLE = String.raw`(?:ambulance|team|driver|एम्बुलेंस|एंबुलेंस|ऐम्बुलेंस|एम्बुलन्स|रुग्णवाहिका|गा(?:\u0921\u093C|\u095C|\u0921)ी|टीम|ड्राइवर|ड्रायव्हर|એમ્બ્યુલન્સ|ગાડી|ટીમ|ડ્રાઇવર)`;
/**
 * A word between a second-person pronoun and the verb. Never a first-person pronoun or an ambulance word: with one of
 * those between them, the pronoun is not the verb's subject ("आप रुकिए, एम्बुलेंस भेज दी है").
 */
const INNER_WORD = String.raw`(?!${FIRST_PERSON}${WORD_END}|${VEHICLE})[\p{L}\p{M}'\u2019]+`;
/** Hindi postpositions after आप/तुम that make the pronoun an object ("आप तक", "आप के लिए"), not the subject. */
const HI_POSTPOSITION = String.raw`(?:को|के|की|का|तक|से|पर|में|लिए)`;
/** A second-person subject: "you are"/"you're"/"are you", आप(ने), तुम(ने), तुम्ही, તમે. */
const SECOND_PERSON = String.raw`(?:you(?:['\u2019]re|['\u2019]ll${GAP}be|${GAP}(?:are|were|will${GAP}be))|(?:are|were)${GAP}you|(?:आप|तुम)(?:ने)?${WORD_END}(?!${GAP}${HI_POSTPOSITION}${WORD_END})|तुम्ही|તમે)${WORD_END}`;
/** Not within two words after a second-person subject: then the reporter is the one sending or travelling. */
const NOT_SECOND_PERSON = String.raw`(?<!${WORD_START}${SECOND_PERSON}(?:${GAP}${INNER_WORD}){0,2}${GAP})`;
/** Not right after the word for a number: "नंबर भेज रहे", "नंबर पाठवत", "નંબર મોકલી" send a number, not an ambulance. */
const NOT_AFTER_NUMBER = String.raw`(?<!(?:नंबर|नम्बर|क्रमांक|number|નંબર)${GAP})`;
/** "sending (you) (the) (driver's) number/contact/details": we send numbers, never ambulances. */
const NOT_SENDING_A_NUMBER = String.raw`(?!${GAP}(?:you${GAP})?(?:(?:the|his|her|their|its|this|that|our)${GAP})?(?:(?:driver|ambulance|unit|helpline|clinic)(?:['\u2019]s)?${GAP}){0,2}(?:phone${GAP})?(?:numbers?|contacts?|details)\b)`;
/** Hindi "आ रही/रहे/रहा है" (is coming): dispatch language only in a sentence that names a VEHICLE. */
const HI_COMING = String.raw`${WORD_START}आ${GAP}रह[ीेा]${GAP}है`;

const DISPATCH_PATTERNS = [
  // English: we're/I'm sending, on the/its/their… way (not "on the way to the clinic"), is/are coming to you, dispatch(ed).
  String.raw`\b(?:we(?:['\u2019]re|${GAP}are)|I(?:['\u2019]m|${GAP}am))${GAP}sending\b${NOT_SENDING_A_NUMBER}`,
  String.raw`${NOT_SECOND_PERSON}\bon${GAP}(?:the${GAP}way\b(?!${GAP}to${GAP}(?:the${GAP})?(?:clinic|vet|hospital))|(?:their|its|his|her|our)${GAP}way\b)`,
  String.raw`(?:\b(?:is|are)|['\u2019](?:s|re))${GAP}coming${GAP}to${GAP}your?\b`,
  String.raw`\bdispatch(?:ed|ing)?\b(?![^\S\n]*-?[^\S\n]*team\b)`,
  // Hindi: भेज रहे/रहा/रही, भेज दी/दिया, भेजी (गई) है, भेजा (गया) है, रास्ते में, and आ रही/रहे/रहा है beside a vehicle or crew.
  String.raw`${NOT_SECOND_PERSON}${NOT_AFTER_NUMBER}${WORD_START}(?:भेज${GAP}(?:रह[ेाी]|(?:दी|दिया)${WORD_END})|भेजी${GAP}(?:गई${GAP})?है|भेजा${GAP}(?:गया${GAP})?है)`,
  String.raw`${NOT_SECOND_PERSON}${WORD_START}रास्ते${GAP}में${WORD_END}`,
  String.raw`${VEHICLE}${SAME_SENTENCE}${HI_COMING}|${HI_COMING}${SAME_SENTENCE}${VEHICLE}`,
  // Marathi: पाठवत आहोत/आहे, पाठवली/पाठवले/पाठवला, वाटेत, रस्त्यात.
  String.raw`${NOT_SECOND_PERSON}${NOT_AFTER_NUMBER}${WORD_START}पाठव(?:त${GAP}आह(?:ोत|े)|ल[ीेा]${WORD_END})`,
  String.raw`${NOT_SECOND_PERSON}${WORD_START}(?:वाटेत|रस्त्यात)${WORD_END}`,
  // Gujarati: મોકલી રહ્યા/રહ્યો/રહી, મોકલી દીધી/દીધો/દીધું, રસ્તામાં.
  String.raw`${NOT_SECOND_PERSON}${NOT_AFTER_NUMBER}${WORD_START}મોકલી${GAP}(?:રહ(?:્યા|્યો|ી)|દીધ[ીોુ])`,
  String.raw`${NOT_SECOND_PERSON}${WORD_START}રસ્તામાં${WORD_END}`,
];

/**
 * Language that says Arham sends the ambulance or that it is on its way, in English, Hindi, Marathi and Gujarati
 * (DISPATCH_PATTERNS). Words may be separated by any horizontal whitespace but never a line break. It does not fire
 * on sending the reporter a number or details, the dispatch team or dispatcher, "on the way to the clinic", or a verb
 * whose subject is the reporter (a second-person subject within two words before it).
 */
export const DISPATCH_RE = new RegExp(DISPATCH_PATTERNS.join("|"), "iu");

export function hasDispatchLanguage(text: string): boolean {
  return DISPATCH_RE.test(normalizeDigits(text));
}

/**
 * A sentence with its terminators and the whitespace after it, a stray run of terminators, or line breaks. A sentence
 * ends only where TERMINATOR allows, and at a line break. Every character lands in one part, so no text is lost when the
 * parts are joined again.
 */
const SENTENCE_RE = new RegExp(String.raw`(?:(?!${TERMINATOR})[^\n])+(?:${TERMINATOR})*\s*|(?:${TERMINATOR})+\s*|\n+`, "giu");

/** One key per number, so "+91 70000 00001" and "7000000001" count once. */
function numberKey(number: string): string {
  const digits = digitsOf(number);
  return digits.length === 12 && digits.startsWith("91") ? digits.slice(2) : digits;
}

/**
 * Replaces each sentence that matches DISPATCH_RE, keeping the whitespace after it, so paragraph breaks survive.
 * Adjacent matching sentences share one replacement. The allowed numbers a replaced sentence held are appended after
 * the replacement, as they were written, so the reporter never loses a number code inserted.
 */
export function replaceDispatchSentences(text: string, replacement: string, allowedNumbers: string[] = []): string {
  const normalized = normalizeDigits(text);
  const parts = normalized.match(SENTENCE_RE) ?? [normalized];
  let out = "";
  for (let i = 0; i < parts.length; ) {
    if (!DISPATCH_RE.test(parts[i])) {
      out += parts[i++];
      continue;
    }
    // A run of adjacent matching sentences: one replacement, then each allowed number they held, once.
    const numbers = new Map<string, string>();
    let trailing = "";
    for (; i < parts.length && DISPATCH_RE.test(parts[i]); i++) {
      splitAllowed(parts[i], allowedNumbers).forEach((part, k) => {
        if (k % 2 === 1 && !numbers.has(numberKey(part))) numbers.set(numberKey(part), part);
      });
      trailing = parts[i].slice(parts[i].trimEnd().length);
    }
    // A danda can end a sentence with no space after it; a space keeps the replacement off the text around it.
    if (out !== "" && !/\s$/.test(out)) out += " ";
    out += [replacement, ...numbers.values()].join(" ") + (trailing === "" && i < parts.length ? " " : trailing);
  }
  return collapseSpaces(out).trim();
}
