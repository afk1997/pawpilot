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
  "बैंगलोर": "bengaluru", "गुरुग्राम": "gurugram", "गुड़गांव": "gurugram",
  // areas — Devanagari
  "घाटकोपर": "ghatkopar", "अंधेरी": "andheri", "बांद्रा": "bandra", "मलाड": "malad", "कांदिवली": "kandivali",
  "बोरीवली": "borivali", "गोरेगांव": "goregaon", "गोरेगाव": "goregaon", "चेंबूर": "chembur", "मुलुंड": "mulund",
  "दादर": "dadar", "वडाला": "wadala", "ठाणे": "thane", "कल्याण": "kalyan", "डोंबिवली": "dombivali",
  "कोथरूड": "kothrud", "पिंपरी": "pimpri", "चिंचवड": "chinchwad", "हिंजवडी": "hinjewadi", "शिवाजीनगर": "shivajinagar",
  // cities — Gujarati
  "મુંબઈ": "mumbai", "અમદાવાદ": "ahmedabad", "સુરત": "surat", "વડોદરા": "vadodara", "રાજકોટ": "rajkot",
  "જામનગર": "jamnagar", "ભાવનગર": "bhavnagar", "ગાંધીનગર": "gandhinagar", "જૂનાગઢ": "junagadh", "મોરબી": "morbi",
  "ગોંડલ": "gondal", "વેરાવળ": "veraval", "પુણે": "pune", "દિલ્હી": "delhi",
  // areas — Gujarati
  "વેસુ": "vesu", "વરાછા": "varachha", "ઘાટકોપર": "ghatkopar", "અંધેરી": "andheri",
};

/** Strip common Indic case suffixes glued to place names ("सुरतमां", "મુંબઈમાં", "नागपुरात"). */
const INDIC_SUFFIXES = ["माँ", "मां", "में", "मे", "ला", "ात", "मध्ये", "માં", "મા", "ના", "થી"];

function stripIndicSuffix(token: string): string {
  for (const suf of INDIC_SUFFIXES) {
    if (token.length > suf.length + 1 && token.endsWith(suf)) return token.slice(0, -suf.length);
  }
  return token;
}

/**
 * Replace aliased tokens in an already lowercased, punctuation-free string.
 * Indic tokens are tried raw, then with a case suffix stripped. Lookups use
 * Object.hasOwn so a token like "constructor" never hits Object.prototype.
 */
export function applyCityAliases(s: string): string {
  return s
    .split(" ")
    .map((token) => {
      if (Object.hasOwn(LATIN_ALIASES, token)) return LATIN_ALIASES[token];
      if (Object.hasOwn(INDIC_ALIASES, token)) return INDIC_ALIASES[token];
      const stripped = stripIndicSuffix(token);
      if (Object.hasOwn(INDIC_ALIASES, stripped)) return INDIC_ALIASES[stripped];
      // Marathi locatives the suffix list does not cover: "पुण्यात" (the stem of पुणे changes) and "मुंबईत".
      if (token === "पुण्यात") return "pune";
      if (token === "मुंबईत") return "mumbai";
      return token;
    })
    .join(" ");
}
