import { isCannotReachMessage, isHumanHandoffRequest } from "../lang";
import type { AnswerIntent, Confidence, ExtractedLocation, IntentClassification } from "./types";

const CITY_AREAS: Record<string, string[]> = {
  Ahmedabad: ["Satellite", "Bopal", "Jivrajpark", "Sela", "South Bopal", "Vastrapur", "Vejalpur"],
  Amravati: [],
  Bengaluru: [],
  Bhavnagar: [],
  Chennai: [],
  Delhi: ["Old Delhi", "Shalimar Bagh", "Ashok Vihar", "Rana Pratap"],
  Gandhinagar: [],
  Gondal: [],
  Gurugram: [],
  Hyderabad: [],
  Indore: [],
  Jamnagar: [],
  Junagadh: [],
  Kolkata: [],
  Mandvi: [],
  Morbi: [],
  Mumbai: [
    "Andheri",
    "Bandra",
    "Bhandup",
    "Bhayandar",
    "Borivali",
    "Chembur",
    "Dadar",
    "Dahisar",
    "Dombivali",
    "Ghatkopar",
    "Goregaon",
    "Jogeshwari",
    "Juhu",
    "Kandivali",
    "Lokhandwala",
    "Malad",
    "Mira Road",
    "Mulund",
    "Nahur",
    "Santacruz",
    "Tardeo",
    "Vikhroli",
    "Vile Parle",
    "Wadala",
  ],
  Nagpur: [],
  Palitana: [],
  Pune: [
    "Ambegaon",
    "Baner",
    "Bhosari",
    "Chinchwad",
    "Dehu",
    "Dhankawadi",
    "Ghorpadi",
    "Handewadi",
    "Hinjewadi",
    "Khadki",
    "Kondwa",
    "PCMC",
    "PMC",
    "Pimpri",
    "Swargate",
    "Yewalewadi",
  ],
  Rajkot: [],
  Solapur: [],
  Surat: ["Vesu", "Varachha"],
  Vadodara: [],
  Vapi: [],
  Veraval: [],
};

const CITY_ALIASES: Record<string, string> = {
  bangalore: "Bengaluru",
  bengaluru: "Bengaluru",
  bombay: "Mumbai",
  mumbai: "Mumbai",
  poona: "Pune",
  pune: "Pune",
  gurgaon: "Gurugram",
  gurugram: "Gurugram",
  baroda: "Vadodara",
  vadodara: "Vadodara",
  delhi: "Delhi",
  ahmedabad: "Ahmedabad",
  surat: "Surat",
  rajkot: "Rajkot",
  nagpur: "Nagpur",
  chennai: "Chennai",
  hyderabad: "Hyderabad",
  kolkata: "Kolkata",
  indore: "Indore",
  मुंबई: "Mumbai",
  मुम्बई: "Mumbai",
  पुणे: "Pune",
  दिल्ली: "Delhi",
  अहमदाबाद: "Ahmedabad",
  सुरत: "Surat",
  राजकोट: "Rajkot",
  नागपुर: "Nagpur",
  चेन्नई: "Chennai",
  हैदराबाद: "Hyderabad",
  कोलकाता: "Kolkata",
  इंदौर: "Indore",
  મുംബൈ: "Mumbai",
  મુંબઈ: "Mumbai",
  મુંમ્બઈ: "Mumbai",
  મુંબઇ: "Mumbai",
  પુણે: "Pune",
  દિલ્હી: "Delhi",
  અમદાવાદ: "Ahmedabad",
  સુરત: "Surat",
  રાજકોટ: "Rajkot",
  નાગપુર: "Nagpur",
  ચેન્નઈ: "Chennai",
  હૈદરાબાદ: "Hyderabad",
  કોલકાતા: "Kolkata",
};

const AREA_ALIASES: Record<string, string> = {
  घाटकोपर: "Ghatkopar",
  कांदिवली: "Kandivali",
  अंधेरी: "Andheri",
  चेंबूर: "Chembur",
  मुलुंड: "Mulund",
  दादर: "Dadar",
  वडाला: "Wadala",
  मालाड: "Malad",
  बोरीवली: "Borivali",
  ઘાટકોપર: "Ghatkopar",
  કાંદિવલી: "Kandivali",
  અંધેરી: "Andheri",
  ચેમ્બુર: "Chembur",
  મુલુંડ: "Mulund",
  દાદર: "Dadar",
  વડાલા: "Wadala",
  મલાડ: "Malad",
  બોરીવલી: "Borivali",
};

const INTENT_PATTERNS: Array<{
  intent: AnswerIntent;
  confidence: Confidence;
  reason: string;
  patterns: RegExp[];
}> = [
  {
    intent: "medical_advice",
    confidence: "high",
    reason: "medical advice or medicine wording",
    patterns: [
      /\b(medicine|medication|dose|dosage|tablet|injection|antibiotic|painkiller|treatment|diagnose|bandage|ointment)\b/i,
      /\b(what should i give|can i give|which medicine|how much medicine)\b/i,
      /(दवा|इलाज|खुराक|इंजेक्शन|पट्टी|दवाई)/,
      /(औषध|उपचार|डोस|इंजेक्शन)/,
      /(દવા|સારવાર|ડોઝ|ઇન્જેક્શન)/,
    ],
  },
  {
    intent: "donation",
    confidence: "high",
    reason: "donation or tax-certificate wording",
    patterns: [
      /\b(donat(e|ion)|80g|tax certificate|csr|refund|razorpay|upi|monthly giving|sponsor)\b/i,
      /(दान|डोनेशन|कर प्रमाणपत्र|सीएसआर)/,
      /(दान|देणगी|कर प्रमाणपत्र)/,
      /(દાન|ટેક્સ પ્રમાણપત્ર|સીએસઆર)/,
    ],
  },
  {
    intent: "volunteer",
    confidence: "high",
    reason: "volunteer wording",
    patterns: [
      /\b(volunteer|join|help your team|internship|fundraising|awareness)\b/i,
      /(स्वयंसेवक|वॉलंटियर|जुड़ना|सेवा करना)/,
      /(स्वयंसेवक|जोडायचे|सेवा)/,
      /(સ્વયંસેવક|જોડાવું|સેવા)/,
    ],
  },
  {
    intent: "clinic",
    confidence: "high",
    reason: "clinic wording",
    patterns: [
      /\b(clinic|hospital|vet|veterinary|nearest doctor|address|hours)\b/i,
      /(क्लिनिक|अस्पताल|पशु चिकित्सक|डॉक्टर)/,
      /(क्लिनिक|रुग्णालय|डॉक्टर|पशुवैद्य)/,
      /(ક્લિનિક|હોસ્પિટલ|ડૉક્ટર|પશુચિકિત્સક)/,
    ],
  },
  {
    intent: "coverage",
    confidence: "high",
    reason: "coverage or availability wording",
    patterns: [
      /\b(covered|coverage|available in|operate in|service in|do you serve|launching soon)\b/i,
      /(कवर|सेवा उपलब्ध|चलती है|शहर में सेवा)/,
      /(सेवा उपलब्ध|कव्हर|शहरात सेवा)/,
      /(સેવા ઉપલબ્ધ|કવર|શહેરમાં સેવા)/,
    ],
  },
  {
    intent: "contact",
    confidence: "medium",
    reason: "official contact or link wording",
    patterns: [
      /\b(contact|email|website|instagram|whatsapp channel|link|privacy|terms)\b/i,
      /(ईमेल|वेबसाइट|संपर्क|लिंक)/,
      /(ईमेल|वेबसाइट|संपर्क|लिंक)/,
      /(ઈમેલ|વેબસાઇટ|સંપર્ક|લિંક)/,
    ],
  },
  {
    intent: "services",
    confidence: "medium",
    reason: "service information wording",
    patterns: [
      /\b(what services|services|what do you do|free service|cost|charges)\b/i,
      /(सेवा|क्या करते|खर्च|फीस|मुफ्त)/,
      /(सेवा|काय करता|खर्च|मोफत)/,
      /(સેવા|શું કરો|ખર્ચ|ફ્રી)/,
    ],
  },
  {
    intent: "org_info",
    confidence: "medium",
    reason: "organization information wording",
    patterns: [
      /\b(who are you|about|organization|ngo|founder|arham|always care|aysg)\b/i,
      /(संस्था|एनजीओ|कौन हैं|अरहम)/,
      /(संस्था|एनजीओ|कोण आहात|अरहम)/,
      /(સંસ્થા|એનજીઓ|કોણ છો|અરહમ)/,
    ],
  },
  {
    intent: "complaint",
    confidence: "high",
    reason: "complaint wording",
    patterns: [
      /\b(complaint|complain|bad service|rude|late|not arrived|issue with driver|problem with team)\b/i,
      /(शिकायत|समस्या|नहीं आया|बुरा व्यवहार)/,
      /(तक्रार|समस्या|आला नाही)/,
      /(ફરિયાદ|સમસ્યા|આવ્યા નથી)/,
    ],
  },
  {
    intent: "thanks",
    confidence: "medium",
    reason: "short acknowledgement",
    patterns: [/^(ok|okay|thanks|thank you|ji|haan|yes|done|👍|🙏)[\s.!]*$/i, /^(ठीक|धन्यवाद|जी|हो|બરાબર|આભાર)$/],
  },
];

const EMERGENCY_PATTERNS = [
  /\b(ambulance|injured|hurt|bleeding|accident|rescue|emergency|wounded|critical|stray|dog|cat|cow|animal|puppy|kitten)\b/i,
  /\b(hit by|fracture|blood|not moving|dying|fallen|stuck|need help)\b/i,
  /(एम्बुलेंस|घायल|जख्मी|खून|कुत्ता|बिल्ली|जानवर|गाय|बचाव|मदद)/,
  /(ॲम्ब्युलन्स|जखमी|रक्त|कुत्रा|मांजर|प्राणी|गाय|मदत)/,
  /(એમ્બ્યુલન્સ|ઇજાગ્રસ્ત|લોહી|કૂતરો|બિલાડી|પ્રાણી|ગાય|મદદ)/,
];

export function classifyIntent(text: string): IntentClassification {
  const normalized = normalize(text);
  const extractedLocation = extractLocation(text);

  if (isCannotReachMessage(text)) {
    return {
      intent: "complaint",
      confidence: "high",
      reason: "reporter says the driver cannot be reached",
      extractedLocation,
    };
  }

  if (isHumanHandoffRequest(text)) {
    return {
      intent: "human_request",
      confidence: "high",
      reason: "manual human handoff request",
      extractedLocation,
    };
  }

  for (const item of INTENT_PATTERNS) {
    if (item.patterns.some((pattern) => pattern.test(text))) {
      return {
        intent: item.intent,
        confidence: item.confidence,
        reason: item.reason,
        extractedLocation,
      };
    }
  }

  if (EMERGENCY_PATTERNS.some((pattern) => pattern.test(text)) || extractedLocation) {
    return {
      intent: "emergency",
      confidence: EMERGENCY_PATTERNS.some((pattern) => pattern.test(text)) ? "high" : "medium",
      reason: "animal emergency or supported location wording",
      extractedLocation,
    };
  }

  if (/\b(faq|question|how)\b/i.test(normalized)) {
    return { intent: "faq", confidence: "low", reason: "general question wording", extractedLocation };
  }

  return { intent: "unknown", confidence: "low", reason: "no deterministic intent match", extractedLocation };
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractLocation(text: string): ExtractedLocation | undefined {
  const normalized = normalize(text);
  let city: string | undefined;
  for (const [alias, canonical] of Object.entries(CITY_ALIASES)) {
    if (containsNormalizedAlias(normalized, alias)) {
      city = canonical;
      break;
    }
  }
  if (!city) {
    for (const candidate of Object.keys(CITY_AREAS)) {
      if (new RegExp(`(^|\\s)${escapeRegExp(candidate.toLowerCase())}(\\s|$)`, "i").test(normalized)) {
        city = candidate;
        break;
      }
    }
  }

  let area: string | undefined;
  for (const [alias, canonical] of Object.entries(AREA_ALIASES)) {
    if (containsNormalizedAlias(normalized, alias)) {
      area = canonical;
      break;
    }
  }
  const areaCandidates = city ? CITY_AREAS[city] ?? [] : Object.values(CITY_AREAS).flat();
  if (!area) {
    for (const candidate of areaCandidates) {
      const normalizedArea = normalize(candidate);
      if (normalizedArea && normalized.includes(normalizedArea)) {
        area = candidate;
        break;
      }
    }
  }

  if (!city && area) {
    const cityHit = Object.entries(CITY_AREAS).find(([, areas]) => areas.includes(area));
    city = cityHit?.[0];
  }

  if (!city && !area) return undefined;
  return { city, area, raw: text };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsNormalizedAlias(normalizedText: string, alias: string): boolean {
  const normalizedAlias = normalize(alias);
  if (!normalizedAlias) return false;
  return new RegExp(`(^|\\s)${escapeRegExp(normalizedAlias)}(\\s|$)`, "i").test(normalizedText);
}
