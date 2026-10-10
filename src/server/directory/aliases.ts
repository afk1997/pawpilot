/**
 * City aliases: colloquial / pre-rename / Indic-script spellings → canonical
 * Latin spelling used in the directory. Applied token-wise after lowercasing.
 */
const LATIN_ALIASES: Record<string, string> = {
  bangalore: "bengaluru", bombay: "mumbai", madras: "chennai", calcutta: "kolkata", mysore: "mysuru",
  mangalore: "mangaluru", gurgaon: "gurugram", baroda: "vadodara", cochin: "kochi", trivandrum: "thiruvananthapuram",
  pondicherry: "puducherry", poona: "pune", vizag: "visakhapatnam", belgaum: "belagavi", hubli: "hubballi",
  allahabad: "prayagraj", benares: "varanasi", banaras: "varanasi",
};

/** Devanagari (Hindi/Marathi) and Gujarati spellings of covered cities and common areas. */
const INDIC_ALIASES: Record<string, string> = {
  // cities — Devanagari
  "मुंबई": "mumbai", "मुम्बई": "mumbai", "पुणे": "pune", "नागपुर": "nagpur", "नागपूर": "nagpur", "सोलापुर": "solapur",
  "सोलापूर": "solapur", "अमरावती": "amravati", "दिल्ली": "delhi", "अहमदाबाद": "ahmedabad", "सूरत": "surat", "सुरत": "surat",
  "वडोदरा": "vadodara", "राजकोट": "rajkot", "जामनगर": "jamnagar", "भावनगर": "bhavnagar", "गांधीनगर": "gandhinagar",
  "इंदौर": "indore", "कोलकाता": "kolkata", "चेन्नई": "chennai", "हैदराबाद": "hyderabad", "बेंगलुरु": "bengaluru",
  "बैंगलोर": "bengaluru", "गुरुग्राम": "gurugram", "गुड़गांव": "gurugram", "अकोला": "akola",
  // areas — Devanagari
  "घाटकोपर": "ghatkopar", "अंधेरी": "andheri", "बांद्रा": "bandra", "मलाड": "malad", "कांदिवली": "kandivali",
  "बोरीवली": "borivali", "गोरेगांव": "goregaon", "गोरेगाव": "goregaon", "चेंबूर": "chembur", "मुलुंड": "mulund",
  "दादर": "dadar", "वडाला": "wadala", "ठाणे": "thane", "कल्याण": "kalyan", "डोंबिवली": "dombivali",
  "कोथरूड": "kothrud", "पिंपरी": "pimpri", "चिंचवड": "chinchwad", "हिंजवडी": "hinjewadi", "शिवाजीनगर": "shivajinagar",
  // cities — Gujarati
  "મુંબઈ": "mumbai", "અમદાવાદ": "ahmedabad", "સુરત": "surat", "વડોદરા": "vadodara", "રાજકોટ": "rajkot",
  "જામનગર": "jamnagar", "ભાવનગર": "bhavnagar", "ગાંધીનગર": "gandhinagar", "જૂનાગઢ": "junagadh", "મોરબી": "morbi",
  "ગોંડલ": "gondal", "વેરાવળ": "veraval", "પુણે": "pune", "દિલ્હી": "delhi", "અકોલા": "akola",
  // areas — Gujarati
  "વેસુ": "vesu", "વરાછા": "varachha", "ઘાટકોપર": "ghatkopar", "અંધેરી": "andheri",
};

/** Strip common Indic case suffixes glued to place names ("सुरतमां", "મુંબઈમાં", "नागपुरात"). */
const INDIC_SUFFIXES = ["माँ", "मां", "में", "मे", "ला", "ात", "मध्ये", "માં", "મા", "ના", "થી"];

/** The case suffix glued to the end of `token`, or null: never the whole token or all but one letter of it. */
function indicSuffixOf(token: string): string | null {
  for (const suf of INDIC_SUFFIXES) {
    if (token.length > suf.length + 1 && token.endsWith(suf)) return suf;
  }
  return null;
}

/**
 * Marathi locatives the suffix list does not cover, since the stem changes: "पुण्यात" (पुणे), "अकोल्यात" (अकोला), and
 * "मुंबईत". Each counts as the place with the locative "त" glued to it.
 */
const MARATHI_LOCATIVES: Record<string, string> = { "पुण्यात": "pune", "अकोल्यात": "akola", "मुंबईत": "mumbai" };

/** What one token of an already lowercased, punctuation-free string aliases to. */
export interface TokenAlias {
  /** The canonical Latin name ("surat"). */
  name: string;
  /** The case suffix stripped to find it ("માં" in "સુરતમાં", "त" for a Marathi locative); null when the token was the name. */
  suffix: string | null;
}

/**
 * The canonical name one token aliases to, with the case suffix it carried; null when it aliases nothing. Latin and
 * Indic spellings are tried raw, then an Indic one with a case suffix stripped, then the Marathi locatives. Lookups use
 * Object.hasOwn so a token like "constructor" never hits Object.prototype.
 */
export function aliasOfToken(token: string): TokenAlias | null {
  if (Object.hasOwn(LATIN_ALIASES, token)) return { name: LATIN_ALIASES[token], suffix: null };
  if (Object.hasOwn(INDIC_ALIASES, token)) return { name: INDIC_ALIASES[token], suffix: null };
  const suffix = indicSuffixOf(token);
  if (suffix !== null) {
    const stripped = token.slice(0, -suffix.length);
    if (Object.hasOwn(INDIC_ALIASES, stripped)) return { name: INDIC_ALIASES[stripped], suffix };
  }
  if (Object.hasOwn(MARATHI_LOCATIVES, token)) return { name: MARATHI_LOCATIVES[token], suffix: "त" };
  return null;
}

/** Replace aliased tokens in an already lowercased, punctuation-free string (aliasOfToken, token by token). */
export function applyCityAliases(s: string): string {
  return s
    .split(" ")
    .map((token) => aliasOfToken(token)?.name ?? token)
    .join(" ");
}
