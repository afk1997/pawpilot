import { partnerSuffix } from "../messages/cards";
import { LANGUAGES } from "../types";
import { asciiDigits, DIGIT_RUN_RE } from "../digits";

/**
 * The last code guards on a reply before it is sent (spec §5.9 steps 3 and 5). The digit scrubber finds phone-shaped
 * runs the model typed, as opposed to numbers code inserted for tokens; the dispatch guard finds and replaces sentences
 * that say Arham is sending an ambulance. Every function first reads its text through normalizeDigits, so native
 * numerals, invisible characters and unusual separators cannot hide a number; text it returns is in that form.
 */

/** The fewest digits a DIGIT_RUN_RE (src/server/digits.ts, with its known residuals) match holds. */
const MIN_RUN_DIGITS = 7;

/**
 * The form every function here reads: every decimal digit as ASCII (Devanagari, Gujarati, Bengali, fullwidth, …);
 * invisible characters dropped (soft hyphen, zero-width space, word joiner, and zero-width (non-)joiners next to a
 * digit); and between two digits, any run of spaces (NBSP, narrow NBSP, tab, …) as one space and any dash variant as
 * "-". Separators change only between digits, so prose keeps its dashes, indentation and line breaks.
 */
function normalizeDigits(s: string): string {
  return asciiDigits(s)
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

/** The text as the scrubber reads it, with every run replaced by `marker`: masks exactly what the scrubber would find. */
export function maskDigitRuns(text: string, marker: string): string {
  return normalizeDigits(text).replace(new RegExp(DIGIT_RUN_RE), marker);
}

/** The text as the scrubber reads it, with every run replaced by what `replace` returns for it. */
export function replaceDigitRuns(text: string, replace: (run: string) => string): string {
  return normalizeDigits(text).replace(new RegExp(DIGIT_RUN_RE), (run) => replace(run));
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
/** Titles whose dot never ends a sentence ("Dr. Shah", "डॉ. शाह"). */
const TITLE = String.raw`(?:\b(?:Dr|Mr|Mrs|Ms|Smt|Shri|Prof)|(?<![\p{L}\p{M}])डॉ)`;
/**
 * A sentence end: a danda anywhere, or ".", "!" or "?" followed (after any further terminators) by whitespace, the end
 * of the text, a WhatsApp closer ("*", "_") or an emoji, so the dot in a URL ("arhamalwayscare.org/help") or after a
 * title ("Dr. Shah") ends nothing.
 */
const TERMINATOR = String.raw`(?:।|(?<!${TITLE})[.!?](?=[.!?।]*(?:\s|$|[*_]|\p{Extended_Pictographic})))`;
/** A WhatsApp closer or an emoji (with its modifiers and joiners) after a sentence's terminators: part of that sentence. */
const CLOSER = String.raw`(?:[*_]|\p{Extended_Pictographic}|\p{Emoji_Modifier}|\uFE0F|\u200D)`;
const FIRST_PERSON = String.raw`(?:we|I|हम|हमने|मैं|मैंने|आम्ही|मी|અમે|મેં|હું)`;
/**
 * An ambulance or team that can be the subject of a Hindi, Marathi or Gujarati "is coming" or "on the way" phrase, in
 * the spellings replies use (अ\u200Dॅ with or without its joiner), Latin "ambulance" and "team" inside an Indic sentence, and
 * गाड़ी with ड़ in either encoding or as Marathi's गाडी. Never a driver word.
 */
const INDIC_VEHICLE = String.raw`(?:ambulance|team|एम्बुलेंस|एंबुलेंस|ऐम्बुलेंस|एम्बुलेन्स|एम्बुलन्स|एम्ब्युलन्स|ॲम्ब्युलन्स|अ\u200D?ॅम्ब्युलन्स|रुग्णवाहिका|गा(?:\u0921\u093C|\u095C|\u0921)ी|टीम|એમ્બ્યુલન્સ|ઍમ્બ્યુલન્સ|ગાડી|ટીમ)`;
/** An ambulance, vehicle, crew or driver, in every script. */
const VEHICLE = String.raw`(?:driver|ड्राइवर|ड्रायव्हर|ડ્રાઇવર|${INDIC_VEHICLE})`;
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
/** A number, contact or details word in any of the four languages, with whatever is glued to it ("नंबरवर"). */
const NUMBER_WORD = String.raw`(?:नंबर|नम्बर|क्रमांक|संपर्क|जानकारी|डिटेल्स|विवरण|माहिती|तपशील|નંબર|સંપર્ક|માહિતી|વિગતો|number|contact|details)[^\s।.!?,]*`;
/**
 * One word between that word and the verb: never an ambulance or team word (then the vehicle is what was sent), never
 * across a comma or a sentence end; a phone number with single spaces or hyphens counts as one word.
 */
const WINDOW_WORD = String.raw`(?!${INDIC_VEHICLE})(?:\+?\d(?:[ -]?\d)*|[^\s।.!?,]+)`;
/**
 * Not with a number, contact or details word within the two words before the verb: "नंबर पहले ही भेज दिया",
 * "नंबर आधीच पाठवला", "નંબર પહેલેથી મોકલી" send a number, not an ambulance. "यह रहा नंबर, एम्बुलेंस भेज दी है" does not
 * escape: the comma, and the ambulance word, end the window.
 */
const NOT_AFTER_NUMBER = String.raw`(?<!${NUMBER_WORD}(?:${GAP}${WINDOW_WORD}){0,2}${GAP})`;
/** "sending (you) (the) (driver's) number/contact/details": we send numbers, never ambulances. */
const NOT_SENDING_A_NUMBER = String.raw`(?!${GAP}(?:you${GAP})?(?:(?:the|his|her|their|its|this|that|our)${GAP})?(?:(?:driver|ambulance|unit|helpline|clinic)(?:['\u2019]s)?${GAP}){0,2}(?:phone${GAP})?(?:numbers?|contacts?|details)\b)`;
/** An adverb that may stand between the subject and the phrase: "एम्बुलेंस अभी रास्ते में है", "गाड़ी जल्द ही आ रही है". */
const SUBJECT_ADVERB = String.raw`(?:अभी|भी|जल्द(?:${GAP}ही)?|तुरंत|आता|હમણાં)${WORD_END}${GAP}`;
/**
 * An INDIC_VEHICLE word right before the phrase that follows, or with one SUBJECT_ADVERB between: the ambulance or team
 * is that phrase's subject.
 */
const VEHICLE_SUBJECT = String.raw`${WORD_START}${INDIC_VEHICLE}${WORD_END}${GAP}(?:${SUBJECT_ADVERB})?`;
/** Hindi "आ रही/रहा/रहे है/हैं" (is coming), after an optional "to you" ("आपके पास", "आप तक", "आपकी ओर/तरफ़"). */
const HI_COMING = String.raw`(?:(?:आपके${GAP}पास|आप${GAP}तक|आपकी${GAP}(?:ओर|तर(?:फ\u093C?|\u095E)))${GAP})?आ${GAP}रह[ीाे]${GAP}(?:हैं|है)${WORD_END}`;
/** "On the way": Hindi रास्ते में, Marathi रस्त्यात and वाटेत, Gujarati રસ્તામાં (each also means "in the road"). */
const ROAD = String.raw`(?:रास्ते${GAP}में|रस्त्यात|वाटेत|રસ્તામાં)${WORD_END}`;

const DISPATCH_PATTERNS = [
  // English: we're/I'm sending, on the/its/their… way (not "on the way to the clinic"), is/are coming to you, dispatch(ed).
  String.raw`\b(?:we(?:['\u2019]re|${GAP}are)|I(?:['\u2019]m|${GAP}am))${GAP}sending\b${NOT_SENDING_A_NUMBER}`,
  String.raw`${NOT_SECOND_PERSON}\bon${GAP}(?:the${GAP}way\b(?!${GAP}to${GAP}(?:the${GAP})?(?:clinic|vet|hospital))|(?:their|its|his|her|our)${GAP}way\b)`,
  String.raw`(?:\b(?:is|are)|['\u2019](?:s|re))${GAP}coming${GAP}to${GAP}your?\b`,
  String.raw`\bdispatch(?:ed|ing)?\b(?![^\S\n]*-?[^\S\n]*team\b)`,
  // Hindi, Marathi and Gujarati "is coming" and "on the way", precision first: only with an ambulance or team word right
  // before, so "दिक्कत आ रही है", "कुत्ता रास्ते में घायल है" or a driver or pronoun subject never fire.
  String.raw`${VEHICLE_SUBJECT}${HI_COMING}`,
  String.raw`${VEHICLE_SUBJECT}${ROAD}`,
  // Hindi sending: भेज रहे/रहा/रही, भेज दी/दिया, भेजी (गई) है, भेजा (गया) है.
  String.raw`${NOT_SECOND_PERSON}${NOT_AFTER_NUMBER}${WORD_START}(?:भेज${GAP}(?:रह[ेाी]|(?:दी|दिया)${WORD_END})|भेजी${GAP}(?:गई${GAP})?है|भेजा${GAP}(?:गया${GAP})?है)`,
  // Marathi sending: पाठवत आहोत/आहे, पाठवली/पाठवले/पाठवला.
  String.raw`${NOT_SECOND_PERSON}${NOT_AFTER_NUMBER}${WORD_START}पाठव(?:त${GAP}आह(?:ोत|े)|ल[ीेा]${WORD_END})`,
  // Gujarati sending: મોકલી રહ્યા/રહ્યો/રહી, મોકલી દીધી/દીધો/દીધું.
  String.raw`${NOT_SECOND_PERSON}${NOT_AFTER_NUMBER}${WORD_START}મોકલી${GAP}(?:રહ(?:્યા|્યો|ી)|દીધ[ીોુ])`,
];

/**
 * Language that says Arham sends the ambulance or that it is on its way, in English, Hindi, Marathi and Gujarati
 * (DISPATCH_PATTERNS). Words may be separated by any horizontal whitespace but never a line break. It does not fire
 * on sending the reporter a number or details, the dispatch team or dispatcher, "on the way to the clinic", a verb
 * whose subject is the reporter (a second-person subject within two words before it), or an Indic "is coming" or "on
 * the way" without an ambulance or team word right before it (one adverb such as अभी may stand between).
 */
export const DISPATCH_RE = new RegExp(DISPATCH_PATTERNS.join("|"), "iu");

export function hasDispatchLanguage(text: string): boolean {
  return DISPATCH_RE.test(normalizeDigits(text));
}

/**
 * A sentence with its terminators, the closers and emoji right after them and the whitespace after those, a stray run of
 * terminators, or line breaks. A sentence ends only where TERMINATOR allows, and at a line break. Every character lands
 * in one part, so no text is lost when the parts are joined again.
 */
const SENTENCE_RE = new RegExp(
  String.raw`(?:(?!${TERMINATOR})[^\n])+(?:${TERMINATOR})*${CLOSER}*\s*|(?:${TERMINATOR})+${CLOSER}*\s*|\n+`,
  "giu",
);

/** One key per number, so "+91 70000 00001" and "7000000001" count once. */
function numberKey(number: string): string {
  const digits = digitsOf(number);
  return digits.length === 12 && digits.startsWith("91") ? digits.slice(2) : digits;
}

/** The same number in any written form: "+91 70000 00001", "91-70000-00001" and "7000000001" are one. */
export function sameNumber(a: string, b: string): boolean {
  return numberKey(a) === numberKey(b);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The partner label cards.ts writes after a partner unit's number ("(operated by X)", "(X द्वारा संचालित)", …), in every
 * language, at the start of the text after the number. Built from partnerSuffix, so the two cannot drift apart.
 */
const PARTNER_LABEL_RE = (() => {
  const marker = "\u0000";
  const forms = LANGUAGES.map((lang) => {
    const [before, after] = partnerSuffix(marker, lang).split(marker);
    return `${escapeRegExp(before)}[^()\\n]+${escapeRegExp(after)}`;
  });
  return new RegExp(`^[^\\S\\n]*(${forms.join("|")})`, "u");
})();

/**
 * The partner label at the start of `text` (normalized), or null. A label with dispatch wording or a phone-shaped run
 * of its own is never kept: the model can type a lookalike.
 */
function partnerLabelAt(text: string): string | null {
  const label = PARTNER_LABEL_RE.exec(text)?.[1];
  if (label === undefined || DISPATCH_RE.test(label) || runsIn(label).length > 0) return null;
  return label;
}

/**
 * Replaces each sentence that matches DISPATCH_RE, keeping the whitespace after it, so paragraph breaks survive.
 * Adjacent matching sentences share one replacement. The allowed numbers a replaced sentence held are appended after
 * the replacement, as they were written and each with the partner label that followed it, so the reporter never loses
 * a number code inserted or the label that says a partner NGO runs the unit. A number the kept sentences show, or an
 * earlier replacement appended, is not appended again.
 */
export function replaceDispatchSentences(text: string, replacement: string, allowedNumbers: string[] = []): string {
  const normalized = normalizeDigits(text);
  const parts = normalized.match(SENTENCE_RE) ?? [normalized];
  const replaced = parts.map((part) => DISPATCH_RE.test(part));
  const numbersIn = (part: string) => splitAllowed(part, allowedNumbers).filter((_, k) => k % 2 === 1);
  // Every number the text already shows once, by key: those of the kept sentences, then each one a replacement appends.
  const shown = new Map(parts.flatMap((part, i) => (replaced[i] ? [] : numbersIn(part))).map((n) => [numberKey(n), n]));
  let out = "";
  for (let i = 0; i < parts.length; ) {
    if (!replaced[i]) {
      out += parts[i++];
      continue;
    }
    // A run of adjacent matching sentences: one replacement, then each allowed number they held, once, with its label.
    const numbers = new Map<string, { number: string; label: string | null }>();
    let trailing = "";
    for (; i < parts.length && replaced[i]; i++) {
      const pieces = splitAllowed(parts[i], allowedNumbers);
      pieces.forEach((piece, k) => {
        if (k % 2 === 0 || shown.has(numberKey(piece))) return;
        const label = partnerLabelAt(pieces[k + 1] ?? "");
        const kept = numbers.get(numberKey(piece));
        if (kept === undefined) numbers.set(numberKey(piece), { number: piece, label });
        else kept.label ??= label;
      });
      trailing = parts[i].slice(parts[i].trimEnd().length);
    }
    for (const [key, { number }] of numbers) shown.set(key, number);
    const appended = [...numbers.values()].map(({ number, label }) => (label === null ? number : `${number} ${label}`));
    // A danda can end a sentence with no space after it; a space keeps the replacement off the text around it.
    if (out !== "" && !/\s$/.test(out)) out += " ";
    out += [replacement, ...appended].join(" ") + (trailing === "" && i < parts.length ? " " : trailing);
  }
  return collapseSpaces(out).trim();
}
