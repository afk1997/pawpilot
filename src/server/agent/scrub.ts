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
 * An allow-list entry that is a link code inserted (a {{MAPS}} token's map link, "https://maps.google.com/?q=…"), not a
 * number: it is matched as written, and its digits are never read as a run.
 */
const LINK_ENTRY_RE = /^https?:\/\//i;
const isLinkEntry = (entry: string): boolean => LINK_ENTRY_RE.test(entry);

/**
 * Splits normalized text into [free, allowed, free, allowed, …, free]: odd indices hold the allowed numbers and links,
 * which are never read as runs or edited, so digits next to an inserted number cannot merge with it into one run, and
 * an inserted map link's coordinates are never read as a typed number. A number's form glued to another digit or a "+"
 * is not allowed: it reads as part of a foreign run, so a corrupted number is never sent. A link is matched as written,
 * wherever it stands. Allowed numbers shorter than a run are skipped; they can never be a run, and masking them could
 * split a foreign one.
 */
function splitAllowed(normalized: string, allowed: string[]): string[] {
  const links = [...new Set(allowed.filter(isLinkEntry).map(normalizeDigits))].sort((a, b) => b.length - a.length).map(escapeRegExp);
  const digits = allowed.filter((a) => !isLinkEntry(a)).map(digitsOf).filter((d) => d.length >= MIN_RUN_DIGITS);
  const numbers = [...new Set(digits.sort((a, b) => b.length - a.length).map(numberPattern))];
  const patterns = numbers.length > 0 ? [...links, `(?<![\\d+])(?:${numbers.join("|")})(?!\\d)`] : links;
  if (patterns.length === 0) return [normalized];
  return normalized.split(new RegExp(`(${patterns.join("|")})`));
}

/**
 * Runs that are not one of the allowed numbers (formatted, with or without the country code, in any script), read
 * outside the allowed links. `allowed`: the numbers code inserted (and other runs the guard allows) and the links code
 * inserted.
 */
export function foreignDigitRuns(text: string, allowed: string[]): string[] {
  return splitAllowed(normalizeDigits(text), allowed)
    .filter((_, i) => i % 2 === 0)
    .flatMap((part) => runsIn(part));
}

/**
 * A link written in a reply: http(s):// and printable ASCII up to the next space or other character (so a danda or a word
 * glued to it is never part of it), or a map host written without its scheme ("maps.google.com/?q=…", "goo.gl/maps/…",
 * "maps.app.goo.gl/…", "google.com/maps/…"), which WhatsApp makes a link too.
 */
const LINK_TEXT_RE = /https?:\/\/[!-~]+|(?<![\w./-])(?:www\.)?(?:maps\.google\.[a-z.]+|google\.[a-z.]+\/maps|goo\.gl\/maps|maps\.app\.goo\.gl)[!-~]*/gi;
/** Punctuation that ends a sentence or closes WhatsApp formatting right after a link, never part of it. */
const LINK_TRAIL_RE = /[.,;:!?)\]}'"*_]+$/;

/**
 * The links the model typed: every link in the text (LINK_TEXT_RE, its trailing punctuation left out) outside the links
 * code inserted (`inserted`, which splitAllowed keeps whole). Read on the normalized text, as stripLinks edits it.
 */
export function typedLinks(text: string, inserted: string[]): string[] {
  return splitAllowed(normalizeDigits(text), inserted.filter(isLinkEntry))
    .filter((_, i) => i % 2 === 0)
    .flatMap((part) => Array.from(part.matchAll(new RegExp(LINK_TEXT_RE)), (m) => m[0].replace(LINK_TRAIL_RE, "")))
    .filter((link) => link !== "");
}

/**
 * Removes every occurrence of the links outside the links code inserted (`inserted`, kept whole), with the brackets that
 * held nothing else ("(maps.google.com/…)" leaves no "()"), then the doubled space or the space before punctuation a
 * removal leaves, as stripRuns does. Longer links go first.
 */
export function stripLinks(text: string, links: string[], inserted: string[]): string {
  const targets = [...new Set(links)].filter((l) => l !== "").sort((a, b) => b.length - a.length);
  const remove = (part: string, link: string) => part.replace(new RegExp(`[(\\[][^\\S\\n]*${escapeRegExp(link)}[^\\S\\n]*[)\\]]|${escapeRegExp(link)}`, "g"), "");
  const stripped = splitAllowed(normalizeDigits(text), inserted.filter(isLinkEntry))
    .map((part, i) => (i % 2 === 1 ? part : targets.reduce(remove, part)))
    .join("");
  return collapseSpaces(stripped).replace(/ +([.,!?।])/g, "$1").trim();
}

/** Collapses a run of spaces or tabs that follows a non-space character, so a line's indent (a card's) survives. */
function collapseSpaces(s: string): string {
  return s.replace(/(?<=\S)[ \t]{2,}/g, " ");
}

/**
 * Removes every occurrence of the runs, then the doubled space or the space before punctuation a removal leaves.
 * Pass the allowed list given to foreignDigitRuns: allowed numbers and links are then left whole even where a run's
 * text occurs inside one. Longer runs go first, so a run nested in a longer one cannot leave the longer one's
 * remainder behind.
 */
export function stripRuns(text: string, runs: string[], allowed: string[]): string {
  const targets = [...new Set(runs.map(normalizeDigits))].filter((r) => r !== "").sort((a, b) => b.length - a.length);
  const stripped = splitAllowed(normalizeDigits(text), allowed)
    .map((part, i) => (i % 2 === 1 ? part : targets.reduce((out, run) => out.split(run).join(""), part)))
    .join("");
  return collapseSpaces(stripped).replace(/ +([.,!?।])/g, "$1").trim();
}

// Building blocks of DISPATCH_PATTERNS. JS's \b only knows ASCII letters, so word edges in Indic scripts are spelled out.
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
/** No letter or mark right before: an information word stands at a word start ("अस्पताल" never holds "पता"). */
const INFO_START = String.raw`(?<![\p{L}\p{M}])`;
/**
 * A number, contact or details word, whole, in any of the four languages (Latin words too, inside an Indic sentence). It
 * may stand within two words of the sending verb: "नंबर पहले ही भेज दिया", "ड्राइवर का नंबर ऊपर भेजा है".
 */
const NUMBER_WORD = String.raw`${INFO_START}(?:नंबर|नम्बर|नंबरों|क्रमांक|संपर्क|जानकारी|डिटेल्स|विवरण|माहिती|तपशील|નંબર|નંબરો|સંપર્ક|માહિતી|વિગતો|numbers?|contacts?|details)${WORD_END}`;
/**
 * A location, address, map, link, pin or photo word, whole: a glued locative ("पत्त्यावर", "લોકેશનમાં", "સરનામે") is none. It
 * may stand only right before the verb, or with one PLACE_ADVERB between: one further back is often where something else
 * is sent ("लोकेशन मिलते ही भेज रहे हैं"). पता before है, नहीं, था or चला is "know", never an address.
 */
const PLACE_WORD = String.raw`${INFO_START}(?:लोकेशन|पता(?!${GAP}(?:है|हैं|नहीं|था|थी|थे|चला|चल)${WORD_END})|पते|पत्ता|पत्ते|नक्शा|नक्शे|नकाशा|मैप|मॅप|लिंक|पिन|फोटो|લોકેશન|સરનામું|સરનામા|સરનામાં|નકશો|નકશા|મેપ|લિંક|પિન|ફોટો|locations?|address(?:es)?|maps?|links?|pins?|photos?)${WORD_END}`;
/** Either kind of information word. */
const INFO_WORD = String.raw`(?:${NUMBER_WORD}|${PLACE_WORD})`;
/** An adverb that may stand between a place word and the verb ("पत्ता आधीच पाठवला", "लोकेशन अभी भेज दी"). */
const PLACE_ADVERB = String.raw`(?:अभी|ही|भी|तुरंत|पहले(?:${GAP}ही)?|दोबारा|आधीच|लगेच|पुन्हा|હમણાં|તરત|પહેલેથી|ફરી)${WORD_END}`;
/**
 * A destination or recipient marker. Between a number word and the verb it makes the number where something is sent or
 * who gets it ("पता स्वयंसेवकों को भेज", "नंबर पर कॉल करने वाले भेज"), so it ends the window.
 */
const MARKER = String.raw`(?:पर|पे|को|तक|ला|ने|में|मे|से|वर|कडे|पर्यंत|પર|ને|માં|સુધી|થી)${WORD_END}`;
/**
 * One word between a number word and the verb: never an ambulance or team word, nor a MARKER, never across a comma or a
 * sentence end; a phone number with single spaces or hyphens counts as one word.
 */
const WINDOW_WORD = String.raw`(?!${INDIC_VEHICLE}|${MARKER})(?:\+?\d(?:[ -]?\d)*|[^\s।.!?,]+)`;
/**
 * The reporter's own ("your"): आपकी, आपका, आपके, तुम्हारी…, तुमची, तुमचा…, आपला…, તમારું, તમારો…. The reporter's own
 * location, address or number is only ever "sent" to a responder, so an information word that is theirs is never exempt.
 */
const REPORTERS = String.raw`(?:आपकी|आपका|आपके|आप${GAP}(?:लोगों${GAP})?(?:की|का|के)|तुम्हारी|तुम्हारा|तुम्हारे|तेरी|तेरा|तेरे|तुमची|तुमचा|तुमचे|तुमच्या|आपली|आपला|आपले|आपल्या|તમારું|તમારો|તમારી|તમારા|તારું|તારો|તારી)${WORD_END}`;
/** A word that ends a possessive phrase: "आपके लिए लोकेशन" is a location sent for the reporter, not theirs. */
const PHRASE_END = String.raw`(?:${MARKER}|(?:लिए|लिये|साथ|पास|बारे|साठी|सोबत|માટે|સાથે|પાસે)${WORD_END})`;
/** Up to two words between an owner and what it owns, none of which ends the phrase ("आपकी भेजी हुई लोकेशन"). */
const OWNED_GAP = String.raw`(?:${GAP}(?!${PHRASE_END})[^\s।.!?,]+){0,2}`;
/** Not the reporter's: no REPORTERS word right before, or within OWNED_GAP ("आपका नंबर", "आप का नंबर"). */
const NOT_REPORTERS = String.raw`(?<!${WORD_START}${REPORTERS}${OWNED_GAP}${GAP})`;
/** A possessive marker, separate ("कुत्ते की") or glued ("कुत्र्याचा", "કૂતરાનું", "उसकी"). */
const OWNER_MARK = String.raw`(?:का|की|के|चा|ची|चे|च्या|નો|ની|નું|ના|નાં)`;
/**
 * A hospital, clinic, unit or ambulance, in every script (Latin words too, inside an Indic sentence): the only owner a place
 * word may have and stay exempt ("अस्पताल की लोकेशन", "हॉस्पिटलचा पत्ता", "હોસ્પિટલનું સરનામું").
 */
const FACILITY = String.raw`(?:अस्पताल|हॉस्पिटल|हास्पिटल|क्लिनिक|दवाखाना|दवाखाने|दवाखान्या|रुग्णालय|रुग्णालया|यूनिट|युनिट|एम्बुलेंस|एंबुलेंस|ऐम्बुलेंस|एम्बुलेन्स|एम्बुलन्स|एम्ब्युलन्स|ॲम्ब्युलन्स|रुग्णवाहिका|रुग्णवाहिके|હોસ્પિટલ|ક્લિનિક|દવાખાનું|દવાખાના|યુનિટ|એમ્બ્યુલન્સ|ઍમ્બ્યુલન્સ|hospital|clinic|unit|ambulance)`;
/** Where a sentence starts: the text's start or a sentence end, then spaces, WhatsApp closers, emoji or opening quotes. */
const SENTENCE_START = String.raw`(?:^|[।.!?\n])(?:[^\S\n]|${CLOSER}|["“‘(])*`;
/** "And", joining two information words ("नंबर और लोकेशन", "पत्ता आणि लोकेशन", "નંબર અને લોકેશન"). */
const AND = String.raw`(?:और|तथा|आणि|व|અને)`;
/**
 * What may stand before an Indic place word in its sentence, up to the verb: an allow-list, so anything else (a recipient
 * other than the reporter, उन्हें, त्यांना, તેમને; वाला or વાળું; इथला, तिथली; any other noun or pronoun) fires. Allowed:
 * the subject (हम, मैं, हमने, आम्ही, मी, અમે, હું, મેં); the reporter as recipient (आपको, आप को, तुम्हें, तुम्हाला,
 * आपल्याला, તમને, आपके लिए, तुमच्यासाठी, તમારા માટે); a facility as owner (अस्पताल की, हॉस्पिटलचा, હોસ્પિટલનું,
 * एम्बुलेंस का); an adverb (अभी, आता, तुरंत, लगेच, હમણાં); another information word and "and" ("नंबर और"); and the
 * determiners and particles यह, ये, वह, ही, हे, तो, આ, એ, તો.
 */
const PLACE_PREFIX_WORD = String.raw`(?:${FIRST_PERSON}|आपको|आप${GAP}को|तुम्हें|तुमको|तुम्हाला|आपल्याला|તમને|તને|आपके${GAP}लि(?:ए|ये)|तुम्हारे${GAP}लि(?:ए|ये)|तुमच्यासाठी|आपल्यासाठी|તમારા${GAP}માટે|તારા${GAP}માટે|${FACILITY}(?:${GAP})?${OWNER_MARK}|${PLACE_ADVERB}|आता|${INFO_WORD}${GAP}${AND}|यह|ये|वह|ही|हे|तो|આ|એ|તો)${WORD_END}`;
/** A place word with nothing but PLACE_PREFIX_WORDs before it in its sentence. */
const PLACE_PREFIX_OK = String.raw`(?<=${SENTENCE_START}(?:${PLACE_PREFIX_WORD}${GAP})*)`;
/**
 * What a sending verb may follow without dispatching anything: a number word within two words of it, never the reporter's
 * (NOT_REPORTERS); or a place word right before it (one PLACE_ADVERB may stand between) with only the allow-list before it
 * in its sentence (PLACE_PREFIX_OK).
 */
const INFO_BEFORE_VERB = String.raw`(?:${NOT_REPORTERS}${NUMBER_WORD}(?:${GAP}${WINDOW_WORD}){0,2}|${PLACE_PREFIX_OK}${PLACE_WORD}(?:${GAP}${PLACE_ADVERB})?)${GAP}`;
/**
 * A place word off the allow-list (PLACE_PREFIX_OK fails) within four words before the verb, no comma or sentence end
 * between: the verb's object even when a number word stands nearer the verb ("हम उन्हें लोकेशन और नंबर भेज रहे हैं").
 */
const PLACE_OFF_LIST_BEFORE_VERB = String.raw`(?<=(?<!${SENTENCE_START}(?:${PLACE_PREFIX_WORD}${GAP})*)${PLACE_WORD}(?:${GAP}[^\s।.!?,]+){0,4}${GAP})`;
/** An English number, contact or details noun. */
const NUMBER_NOUN = String.raw`(?:numbers?|contacts?|details|info(?:rmation)?)`;
/** An English location, address, map, link, pin, photo or directions noun. */
const PLACE_NOUN = String.raw`(?:locations?|address(?:es)?|maps?|links?|pins?|photos?|pictures?|directions)`;
/** An English information noun of either kind: what "we are sending" may name without dispatching anything. */
const INFO_NOUN = String.raw`(?:${NUMBER_NOUN}|${PLACE_NOUN})`;
/**
 * A word between the determiner and a number noun, as main reads it: whose number it is, a driver, ambulance, unit,
 * helpline, clinic or hospital, possessive or not ("the driver's number", "the ambulance driver's phone number", "the
 * helpline number"), or phone, contact, Google Maps. Never any other possessive ("someone's number").
 */
const INFO_MODIFIER = String.raw`(?:(?:driver|ambulance|unit|helpline|clinic|hospital)(?:['\u2019]s)?|google|maps?|phone|contact)`;
/** A hospital, clinic, unit or ambulance in English: the only owner a place noun may have and stay exempt. */
const FACILITY_EN = String.raw`(?:hospitals?|clinics?|units?|ambulances?)`;
/**
 * A word of a facility's name before it ("the Ghatkopar hospital", "the Mumbai - Ghatkopar Hospital"): never a conjunction,
 * a preposition, an article, a possessive pronoun, or a person or vehicle that could be sent.
 */
const NAME_TOKEN = String.raw`(?!(?:and|or|with|of|to|for|from|the|a|an|your|my|our|their|his|her|its|vehicles?|vans?|teams?|crews?|drivers?|doctors?|vets?|rescuers?|volunteers?|staff|people|persons?|men|man|workers?|members?|responders?|help|someone|somebody|ngos?|rickshaws?|autos?|cars?|bikes?)\b)[\p{L}-]+`;
/** A facility owning a place noun: "(the Ghatkopar) hospital's", or "hospital" naming whose it is ("the hospital location"). */
const FACILITY_OWNER_EN = String.raw`(?:${NAME_TOKEN}${GAP}){0,3}?${FACILITY_EN}(?:['\u2019]s)?`;
/** A place noun owned by nobody or a facility: "(the|a|an|this) (Ghatkopar hospital's) (Google) (Maps|location) link". */
const PLACE_CORE = String.raw`(?:(?:the|a|an|this)${GAP})?(?:${FACILITY_OWNER_EN}${GAP})?(?:google${GAP})?(?:${PLACE_NOUN}${GAP})?${PLACE_NOUN}\b`;
/** A number noun as main reads it: a determiner (never "your") and main's naming words before it ("the driver's number"). */
const NUMBER_CORE = String.raw`(?:(?:the|a|an|this|its|that|our|his|her|their)${GAP})?(?:${INFO_MODIFIER}${GAP}){0,3}${NUMBER_NOUN}\b`;
/** "And" another information noun ("and the address", "and the ambulance number", "and the driver's number"). */
const AND_INFO_EN = String.raw`and${GAP}(?:${PLACE_CORE}|${NUMBER_CORE})`;
/** "Of" a facility ("of the Ghatkopar hospital"). */
const OF_FACILITY_EN = String.raw`of${GAP}(?:the${GAP})?(?:${NAME_TOKEN}${GAP}){0,3}?${FACILITY_EN}\b`;
/** "For you" or "to you": the reporter as recipient. */
const TO_YOU_EN = String.raw`(?:for|to)${GAP}you\b`;
/** Where a place object may end: the sentence's end, a WhatsApp closer or emoji, a colon, a link (masked as "#") or a token. */
const OBJECT_END_EN = String.raw`[^\S\n]*(?:$|[.!?।\n]|${CLOSER}|:|#|\{\{)`;
/**
 * A place noun as the direct object of "sending", an allow-list on both sides: before it only "you" and a PLACE_CORE (a
 * determiner, a facility owner, "Google Maps"); after it only "and" another information noun, "of" a facility, or "for
 * you"/"to you", up to the object's end (OBJECT_END_EN). Anything else fires: "your location", "the dog's location",
 * "them the location", "the location of the dog", "the location for pickup", "the location you shared", "the location now".
 */
const PLACE_OBJECT = String.raw`(?:you${GAP})?${PLACE_CORE}(?:${GAP}(?:${AND_INFO_EN}|${OF_FACILITY_EN}|${TO_YOU_EN})){0,3}(?=${OBJECT_END_EN})`;
/**
 * A number noun as the direct object, as main reads it: anything may follow but "to" or an AGENT (NOT_SENDING_INFO_EN), so
 * "the number below" stays exempt. A place noun later in its sentence must be joined to it by "and" (AND_INFO_EN), so the
 * place allow-list holds there too: "the number and the dog's location" fires.
 */
const NUMBER_OBJECT = String.raw`(?:you${GAP})?${NUMBER_CORE}(?:${GAP}(?:${AND_INFO_EN}|${TO_YOU_EN})){0,3}(?![^.!?\n]{0,400}\b${PLACE_NOUN}\b)`;
/** The direct object of "sending" when it is information: a place noun (PLACE_OBJECT) or a number noun (NUMBER_OBJECT). */
const INFO_OBJECT = String.raw`${GAP}(?:${PLACE_OBJECT}|${NUMBER_OBJECT})`;
/**
 * Help, or a vehicle or people sent to help, in every script: an ambulance, vehicle, van, team, unit or crew, a driver,
 * doctor, vet or paramedic, a rescuer, volunteer, staff or people, help itself, or someone. An Indic word may carry a
 * plural or dative ending ("स्वयंसेवकों", "ड्रायव्हरला", "કર્મચારીઓ"), never a glued possessive ("ड्रायव्हरचा").
 */
const AGENT = String.raw`${WORD_START}(?:ambulances?|vehicles?|vans?|gaadi|gadi|teams?|units?|crews?|drivers?|doctors?|vets?|paravets?|paramedics?|rescue|rescuers?|volunteers?|staff|people|personnel|persons?|man|men|workers?|members?|responders?|rickshaws?|autos?|cars?|bikes?|ngos?|help|someone|somebody|(?:${INDIC_VEHICLE}|आदमी|आदमियों|व्यक्ति|व्यक्तियों|इंसान|ल(?:\u0921\u093C|\u095C)(?:का|के|कों)|कार्यकर्ता|कार्यकर्ताओं|सदस्य|रिक्शा|माणूस|माणसे|माणसं|व्यक्ती|कार्यकर्ते|रिक्षा|માણસ|માણસો|વ્યક્તિ|કાર્યકર|કાર્યકરો|રિક્ષા|ड्राइवर|ड्रायव्हर|ડ્રાઇવર|डॉक्टर|ડૉક્ટર|ડોક્ટર|वैन|वॅन|વાન|मदद|मदत|મદદ|सहायता|बचाव|બચાવ|रेस्क्यू|स्वयंसेवक|स्वयंसेवी|સ્વયંસેવક|वॉलंटियर|वालंटियर|यूनिट|युनिट|યુનિટ|स्टाफ|સ્ટાફ|कर्मचारी|कर्मचारियों|કર્મચારી|लोग|लोक|લોકો|किसी${GAP}को|कोणाला(?:${GAP}तरी)?|कुणाला|કોઈને)(?:ों|ें|े|ां|ांना|ांनी|ला|ना|ने|ને|ો|ોને|ઓ|ઓને)?)${WORD_END}`;
/** A possessive after a word ("एम्बुलेंस का", "ड्राइवर ची", "ડ્રાઇવર નો"). */
const POSSESSIVE = String.raw`${OWNER_MARK}${WORD_END}`;
/**
 * An AGENT named as something sent. Not when it only says whose information it is: before a possessive and an information
 * word ("the ambulance's number", "ड्राइवर का नंबर", "एम्बुलेंस के ड्राइवर का नंबर"), or right before a number word or an
 * English information noun ("the ambulance number", "यूनिट नंबर"). Anything else counts, "with", "for" or "to" it
 * included ("एम्बुलेंस के साथ", "एम्बुलेंस का इंतज़ार").
 */
const AGENT_MENTION = String.raw`${AGENT}(?!(?:['\u2019]s)?${GAP}(?:${INFO_MODIFIER}${GAP}){0,2}${INFO_NOUN}\b)(?!${GAP}${POSSESSIVE}(?:${GAP}[^\s।.!?,]+${GAP}${POSSESSIVE})?${GAP}${INFO_WORD})(?!${GAP}${NUMBER_WORD})`;
/**
 * The Hindi, Marathi and Gujarati sending verbs' information exemption, narrow (precision first: when in doubt, the guard
 * fires). It holds only when an information word stands as the verb's object (INFO_BEFORE_VERB), no place word off the
 * allow-list stands in that object (PLACE_OFF_LIST_BEFORE_VERB), and the sentence names no AGENT as sent anywhere, before
 * the verb or after it. Each scan stops at 400 characters, so a long reply costs a few milliseconds at most; no reply
 * sentence is that long.
 */
const NOT_SENDING_INFO = String.raw`(?:(?<!${INFO_BEFORE_VERB})|${PLACE_OFF_LIST_BEFORE_VERB}|(?<=${AGENT_MENTION}[^.!?।\n]{0,400})|(?=[^.!?।\n]{0,400}${AGENT_MENTION}))`;
/**
 * The English exemption, as narrow: "we are/I'm sending" fires unless its direct object is an information noun
 * (INFO_OBJECT), no "to" follows the object in the sentence ("the number to call"), and the sentence names no AGENT as
 * sent, before "sending" or after the object.
 */
const NOT_SENDING_INFO_EN = String.raw`(?:(?<=${AGENT_MENTION}[^.!?\n]{0,400})|(?!${INFO_OBJECT}(?![^.!?\n]{0,400}(?:\bto\b|${AGENT_MENTION}))))`;
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
  String.raw`\b(?:we(?:['\u2019]re|${GAP}are)|I(?:['\u2019]m|${GAP}am))${GAP}sending\b${NOT_SENDING_INFO_EN}`,
  String.raw`${NOT_SECOND_PERSON}\bon${GAP}(?:the${GAP}way\b(?!${GAP}to${GAP}(?:the${GAP})?(?:clinic|vet|hospital))|(?:their|its|his|her|our)${GAP}way\b)`,
  String.raw`(?:\b(?:is|are)|['\u2019](?:s|re))${GAP}coming${GAP}to${GAP}your?\b`,
  String.raw`\bdispatch(?:ed|ing)?\b(?![^\S\n]*-?[^\S\n]*team\b)`,
  // Hindi, Marathi and Gujarati "is coming" and "on the way", precision first: only with an ambulance or team word right
  // before, so "दिक्कत आ रही है", "कुत्ता रास्ते में घायल है" or a driver or pronoun subject never fire.
  String.raw`${VEHICLE_SUBJECT}${HI_COMING}`,
  String.raw`${VEHICLE_SUBJECT}${ROAD}`,
  // Hindi sending: भेज रहे/रहा/रही, भेज दी/दिया, भेजी (गई) है, भेजा (गया) है.
  String.raw`(?=भेज)${NOT_SECOND_PERSON}${NOT_SENDING_INFO}${WORD_START}(?:भेज${GAP}(?:रह[ेाी]|(?:दी|दिया)${WORD_END})|भेजी${GAP}(?:गई${GAP})?है|भेजा${GAP}(?:गया${GAP})?है)`,
  // Marathi sending: पाठवत आहोत/आहे, पाठवली/पाठवले/पाठवला.
  String.raw`(?=पाठव)${NOT_SECOND_PERSON}${NOT_SENDING_INFO}${WORD_START}पाठव(?:त${GAP}आह(?:ोत|े)|ल[ीेा]${WORD_END})`,
  // Gujarati sending: મોકલી રહ્યા/રહ્યો/રહી, મોકલી દીધી/દીધો/દીધું.
  String.raw`(?=મોકલી)${NOT_SECOND_PERSON}${NOT_SENDING_INFO}${WORD_START}મોકલી${GAP}(?:રહ(?:્યા|્યો|ી)|દીધ[ીોુ])`,
];

/**
 * Language that says Arham sends the ambulance or that it is on its way, in English, Hindi, Marathi and Gujarati
 * (DISPATCH_PATTERNS). Words may be separated by any horizontal whitespace but never a line break. It does not fire
 * on sending the reporter information (a number, contact or details, a location, address, map, link, pin, photo or
 * directions) as the verb's direct object in a sentence that names nothing else as sent (NOT_SENDING_INFO_EN,
 * NOT_SENDING_INFO: narrow, so when in doubt it fires), nor on the dispatch team or dispatcher, "on the way to the clinic", a verb
 * whose subject is the reporter (a second-person subject within two words before it), or an Indic "is coming" or "on
 * the way" without an ambulance or team word right before it (one adverb such as अभी may stand between). Each Indic
 * sending pattern checks for its verb first, so the lookarounds before it run only where the verb stands.
 *
 * One regex per pattern, tried in turn: V8 takes seconds to compile their alternation for a text outside Latin-1 (any
 * Indic script, a curly quote, an en dash) the first time, which would stall the first such reply after every worker
 * start; each pattern alone compiles in milliseconds.
 */
const DISPATCH_RES = DISPATCH_PATTERNS.map((pattern) => new RegExp(pattern, "iu"));

/** Whether any DISPATCH_PATTERNS pattern matches the text. */
function matchesDispatch(s: string): boolean {
  return DISPATCH_RES.some((re) => re.test(s));
}

/**
 * A link in a reply, printable ASCII up to the next space or other character, so a danda or a word glued to it ("…।एम्बुलेंस
 * आ रही है") stays outside it: the dispatch guard never reads the link, and always reads what follows it.
 */
const LINK_IN_TEXT_RE = /https?:\/\/[!-~]+/gi;

/**
 * The text with each link written as one "#": a link's words ("…/ambulance-dispatched", "…?q=we+are+sending") are never
 * dispatch language, and no words join across the gap it leaves.
 */
function withoutLinks(s: string): string {
  return s.replace(LINK_IN_TEXT_RE, "#");
}

/** matchesDispatch on the text, its links skipped (withoutLinks). */
export function hasDispatchLanguage(text: string): boolean {
  return matchesDispatch(withoutLinks(normalizeDigits(text)));
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
  if (label === undefined || matchesDispatch(label) || runsIn(label).length > 0) return null;
  return label;
}

/**
 * Replaces each sentence that matches a dispatch pattern (its links skipped, as hasDispatchLanguage reads it), keeping the
 * whitespace after it, so paragraph breaks survive. Adjacent matching sentences share one replacement. The allowed
 * numbers a replaced sentence held are appended after the replacement, as they were written and each with the partner
 * label that followed it, so the reporter never loses a number code inserted or the label that says a partner NGO runs
 * the unit; so are the allowed links it held (a map link). A number or link the kept sentences show, or an earlier
 * replacement appended, is not appended again.
 */
export function replaceDispatchSentences(text: string, replacement: string, allowed: string[] = []): string {
  const normalized = normalizeDigits(text);
  const parts = normalized.match(SENTENCE_RE) ?? [normalized];
  const replaced = parts.map((part) => matchesDispatch(withoutLinks(part)));
  const numbersIn = (part: string) => splitAllowed(part, allowed).filter((_, k) => k % 2 === 1);
  /** One key per number (numberKey) or link (itself). */
  const keyOf = (piece: string) => (isLinkEntry(piece) ? piece : numberKey(piece));
  // Every number or link the text already shows once, by key: those of the kept sentences, then each one a replacement appends.
  const shown = new Map(parts.flatMap((part, i) => (replaced[i] ? [] : numbersIn(part))).map((n) => [keyOf(n), n]));
  let out = "";
  for (let i = 0; i < parts.length; ) {
    if (!replaced[i]) {
      out += parts[i++];
      continue;
    }
    // A run of adjacent matching sentences: one replacement, then each allowed number (with its label) or link they
    // held, once.
    const numbers = new Map<string, { number: string; label: string | null }>();
    let trailing = "";
    for (; i < parts.length && replaced[i]; i++) {
      const pieces = splitAllowed(parts[i], allowed);
      pieces.forEach((piece, k) => {
        if (k % 2 === 0 || shown.has(keyOf(piece))) return;
        // Only a number carries a partner label.
        const label = isLinkEntry(piece) ? null : partnerLabelAt(pieces[k + 1] ?? "");
        const kept = numbers.get(keyOf(piece));
        if (kept === undefined) numbers.set(keyOf(piece), { number: piece, label });
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
