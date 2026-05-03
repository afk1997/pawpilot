import { audit } from "../audit";
import { buildAmbulanceCard, buildMultiAmbulanceCard } from "../ambulance-card";
import { buildClinicCard, type ClinicRow } from "../cards/clinic";
import { findAmbulanceByArea, type AmbulanceRow } from "../tools/find-ambulance-by-area";
import { escalateToDispatcher } from "../tools/escalate-to-dispatcher";
import { supabase } from "../supabase";
import type { Language } from "../types";
import {
  getCoverageStatus,
  getFactsByCategory,
  getOfficialLinks,
  getResponseTemplates,
  searchKnowledgeBase,
  type CoverageStatusResult,
} from "../kb/repository";
import { classifyIntent } from "./classify-intent";
import { validateAnswer } from "./validate-answer";
import type {
  AnswerIntent,
  AnswerValidationResult,
  Confidence,
  EvidenceFact,
  EvidencePack,
  IntentClassification,
} from "./types";

export interface AnswerEngineTurnInput {
  conversationId: string;
  inboundMessageId: string;
  inboundText: string;
  reporterPhone: string;
  reporterName: string | null;
  language: Language;
}

export interface AnswerEngineTurnResult {
  text: string;
  intent: AnswerIntent;
  language: Language;
  confidence: Confidence;
  evidence: EvidencePack;
  validation: AnswerValidationResult;
  deliveredAmbulanceId?: string;
  escalated?: boolean;
  metadata?: Record<string, unknown>;
}

const EMPTY_EVIDENCE = (intent: AnswerIntent, language: Language, confidence: Confidence): EvidencePack => ({
  intent,
  language,
  confidence,
  deterministicFacts: [],
  officialLinks: [],
  articles: [],
  templates: [],
  forbiddenClaims: [],
  validationContext: {
    allowedPhoneNumbers: [],
    allowedUrls: [],
    allowedFactKeys: [],
    allowedCoverageClaims: [],
  },
});

export async function runAnswerEngineTurn(input: AnswerEngineTurnInput): Promise<AnswerEngineTurnResult> {
  const classification = classifyIntent(input.inboundText);
  const result = await runClassifiedTurn(input, classification);
  if (!result.validation.valid && result.intent === "emergency") {
    await escalateToDispatcher(input.conversationId, { reason: "answer_validation_failed" });
    return { ...result, escalated: true };
  }
  return result;
}

async function runClassifiedTurn(
  input: AnswerEngineTurnInput,
  classification: IntentClassification
): Promise<AnswerEngineTurnResult> {
  const language = input.language;

  if (classification.intent === "human_request" || classification.intent === "complaint") {
    const reason =
      classification.intent === "human_request" ? "manual_human_request" : "cannot_reach_driver_or_complaint";
    await escalateToDispatcher(input.conversationId, { reason });
    return finalize({
      text: HANDOFF_ACK[language] ?? HANDOFF_ACK.en,
      intent: classification.intent,
      language,
      confidence: classification.confidence,
      evidence: EMPTY_EVIDENCE(classification.intent, language, classification.confidence),
      metadata: { classification },
      escalated: true,
    });
  }

  switch (classification.intent) {
    case "emergency":
      return handleEmergency(input, classification);
    case "clinic":
      return handleClinics(input, classification);
    case "donation":
      return handleFactsAndLinks(input, classification, {
        category: "donation",
        linkKeys: ["donate", "refund_cancellation", "email_support"],
        header: DONATION_HEADER,
        preferredFactKeys: [
          "donation.80g_certificate",
          "donation.payment_methods_supported",
          "donation.suggested_amounts",
          "donation.impact_statement_rs_100",
          "donation.impact_statement_rs_2000",
          "donation.recurring_donation",
          "donation.csr_corporate_support",
        ],
      });
    case "volunteer":
      return handleFactsAndLinks(input, classification, {
        category: "volunteer",
        linkKeys: ["volunteer", "email_support"],
        header: VOLUNTEER_HEADER,
        preferredFactKeys: [
          "volunteer.response_time",
          "volunteer.time_commitment",
          "volunteer.role_1_on_ground_rescue_support",
          "volunteer.role_2_social_media_and_awareness",
          "volunteer.role_3_fundraising_and_events",
          "volunteer.role_4_vet_medical",
        ],
      });
    case "coverage":
      return handleCoverage(input, classification);
    case "contact":
      return handleContact(input, classification);
    case "medical_advice":
      return finalize({
        text: MEDICAL_REFUSAL[language] ?? MEDICAL_REFUSAL.en,
        intent: "medical_advice",
        language,
        confidence: classification.confidence,
        evidence: EMPTY_EVIDENCE("medical_advice", language, classification.confidence),
        metadata: { classification },
      });
    case "org_info":
    case "services":
    case "faq":
    case "unknown":
    case "thanks":
    default:
      return handleKnowledgeSearch(input, classification);
  }
}

async function handleEmergency(
  input: AnswerEngineTurnInput,
  classification: IntentClassification
): Promise<AnswerEngineTurnResult> {
  const language = input.language;
  const query = locationQuery(classification);
  const evidence = EMPTY_EVIDENCE("emergency", language, classification.confidence);

  if (!query) {
    return finalize({
      text: ASK_CITY[language] ?? ASK_CITY.en,
      intent: "emergency",
      language,
      confidence: classification.confidence,
      evidence,
      metadata: { classification, missingLocation: true },
    });
  }

  const rows = await findAmbulanceByArea({ query, language });
  await auditTool(input.conversationId, "find_ambulance_by_area", { query, language }, rows);
  evidence.validationContext.allowedPhoneNumbers = rows.map((row) => row.phone);

  const coverage = await getCoverageStatus({
    city: classification.extractedLocation?.city,
    area: classification.extractedLocation?.area,
  });
  await auditTool(input.conversationId, "get_coverage_status", classification.extractedLocation ?? {}, coverage);
  addCoverageFacts(evidence, coverage);

  if (rows.length === 0) {
    const launching = coverage.find((row) => row.status === "launching_soon");
    const place = query;
    const text = launching
      ? launchingSoonText(language, place)
      : outOfCoverageText(language, place);
    return finalize({
      text,
      intent: "emergency",
      language,
      confidence: classification.confidence,
      evidence,
      metadata: { classification, matchCount: 0 },
    });
  }

  let text: string;
  let deliveredAmbulanceId: string | undefined;
  if (rows.length === 1) {
    text = buildEmergencyCard(rows[0], language, coverage);
    deliveredAmbulanceId = rows[0].id;
  } else if (rows.length <= 3) {
    text = buildMultiAmbulanceCard(rows, language);
  } else {
    text = askAreaText(language, rows);
  }

  return finalize({
    text,
    intent: "emergency",
    language,
    confidence: classification.confidence,
    evidence,
    deliveredAmbulanceId,
    metadata: { classification, matchCount: rows.length },
  });
}

async function handleClinics(
  input: AnswerEngineTurnInput,
  classification: IntentClassification
): Promise<AnswerEngineTurnResult> {
  const language = input.language;
  const city = classification.extractedLocation?.city;
  let query = supabase
    .from("clinics")
    .select("label,city,area,phone,address,hours")
    .eq("active", true)
    .limit(5);
  if (city) query = query.ilike("city", city);
  const { data, error } = await query;
  const rows = error ? [] : ((data as ClinicRow[] | null) ?? []);
  if (error) console.warn("clinic retrieval failed:", error.message);
  await auditTool(input.conversationId, "get_clinics", { city }, rows);

  const evidence = EMPTY_EVIDENCE("clinic", language, classification.confidence);
  evidence.validationContext.allowedPhoneNumbers = rows.map((row) => row.phone);
  evidence.officialLinks = await getOfficialLinks({ keys: ["find_clinic"] });
  evidence.validationContext.allowedUrls = evidence.officialLinks.map((link) => link.url);

  return finalize({
    text: buildClinicCard(rows, language),
    intent: "clinic",
    language,
    confidence: classification.confidence,
    evidence,
    metadata: { classification, clinicCount: rows.length },
  });
}

async function handleFactsAndLinks(
  input: AnswerEngineTurnInput,
  classification: IntentClassification,
  config: {
    category: "donation" | "volunteer";
    linkKeys: string[];
    header: Record<Language, string>;
    preferredFactKeys: string[];
  }
): Promise<AnswerEngineTurnResult> {
  const language = input.language;
  const [facts, links] = await Promise.all([
    getFactsByCategory(config.category),
    getOfficialLinks({ keys: config.linkKeys }),
  ]);
  await auditTool(input.conversationId, `get_${config.category}_info`, {}, { facts, links });

  const evidence = EMPTY_EVIDENCE(config.category, language, classification.confidence);
  evidence.deterministicFacts = facts;
  evidence.officialLinks = links;
  evidence.validationContext.allowedFactKeys = facts.map((fact) => fact.key);
  evidence.validationContext.allowedUrls = links.map((link) => link.url);

  const lines = [config.header[language] ?? config.header.en];
  const primaryLink = config.linkKeys
    .map((key) => links.find((link) => link.key === key))
    .find(Boolean);
  if (primaryLink) lines.push(primaryLink.url);

  for (const fact of selectFacts(facts, config.preferredFactKeys, 5)) {
    lines.push(`${fact.label}: ${fact.value}`);
  }

  const emailFact = facts.find((fact) => /email|contact|csr/i.test(`${fact.label} ${fact.value}`));
  if (emailFact && !lines.some((line) => line.includes(emailFact.value))) {
    lines.push(`${emailFact.label}: ${emailFact.value}`);
  }

  if (lines.length === 1) lines.push(UNAVAILABLE[language] ?? UNAVAILABLE.en);

  return finalize({
    text: lines.join("\n"),
    intent: config.category,
    language,
    confidence: classification.confidence,
    evidence,
    metadata: { classification, factCount: facts.length, linkCount: links.length },
  });
}

async function handleCoverage(
  input: AnswerEngineTurnInput,
  classification: IntentClassification
): Promise<AnswerEngineTurnResult> {
  const language = input.language;
  const city = classification.extractedLocation?.city;
  const area = classification.extractedLocation?.area;
  const evidence = EMPTY_EVIDENCE("coverage", language, classification.confidence);
  if (!city && !area) {
    return finalize({
      text: ASK_CITY[language] ?? ASK_CITY.en,
      intent: "coverage",
      language,
      confidence: classification.confidence,
      evidence,
      metadata: { classification },
    });
  }

  const coverage = await getCoverageStatus({ city, area });
  await auditTool(input.conversationId, "get_coverage_status", { city, area }, coverage);
  addCoverageFacts(evidence, coverage);
  const active = coverage.find((row) => row.status === "active");
  const launching = coverage.find((row) => row.status === "launching_soon");
  const place = [city, area].filter(Boolean).join(" - ");
  const text = active
    ? activeCoverageText(language, place || active.city, active.notes)
    : launching
      ? launchingSoonText(language, place || launching.city)
      : outOfCoverageText(language, place || input.inboundText);

  return finalize({
    text,
    intent: "coverage",
    language,
    confidence: classification.confidence,
    evidence,
    metadata: { classification, coverageCount: coverage.length },
  });
}

async function handleContact(
  input: AnswerEngineTurnInput,
  classification: IntentClassification
): Promise<AnswerEngineTurnResult> {
  const language = input.language;
  const links = await getOfficialLinks();
  await auditTool(input.conversationId, "get_official_link", {}, links);
  const evidence = EMPTY_EVIDENCE("contact", language, classification.confidence);
  evidence.officialLinks = links;
  evidence.validationContext.allowedUrls = links.map((link) => link.url);
  const selected = links.filter((link) =>
    ["website", "email_support", "instagram", "whatsapp_channel", "privacy_policy", "terms_conditions"].includes(link.key)
  );
  const lines = [CONTACT_HEADER[language] ?? CONTACT_HEADER.en];
  for (const link of selected.slice(0, 6)) lines.push(`${link.label}: ${link.url}`);
  if (lines.length === 1) lines.push(UNAVAILABLE[language] ?? UNAVAILABLE.en);

  return finalize({
    text: lines.join("\n"),
    intent: "contact",
    language,
    confidence: classification.confidence,
    evidence,
    metadata: { classification, linkCount: links.length },
  });
}

async function handleKnowledgeSearch(
  input: AnswerEngineTurnInput,
  classification: IntentClassification
): Promise<AnswerEngineTurnResult> {
  const language = input.language;
  const categories = classification.intent === "services" ? ["services"] : classification.intent === "org_info" ? ["organization"] : undefined;
  const result =
    classification.intent === "thanks"
      ? { facts: [], articles: [] }
      : await searchKnowledgeBase({ query: input.inboundText, categories, limit: 3 });
  if (classification.intent !== "thanks") {
    await auditTool(input.conversationId, "search_knowledge_base", { query: input.inboundText, categories }, result);
  }
  const templates =
    classification.intent === "thanks" ? await getResponseTemplates({ intent: "thanks" }) : [];
  const evidence = EMPTY_EVIDENCE(classification.intent, language, classification.confidence);
  evidence.deterministicFacts = result.facts;
  evidence.articles = result.articles;
  evidence.templates = templates;
  evidence.validationContext.allowedFactKeys = result.facts.map((fact) => fact.key);

  const text =
    classification.intent === "thanks"
      ? templates[0]?.template ?? THANKS[language] ?? THANKS.en
      : composeKnowledgeAnswer(result.facts, result.articles, language);

  return finalize({
    text,
    intent: classification.intent,
    language,
    confidence: classification.confidence,
    evidence,
    metadata: { classification, factCount: result.facts.length, articleCount: result.articles.length },
  });
}

async function finalize(input: Omit<AnswerEngineTurnResult, "validation">): Promise<AnswerEngineTurnResult> {
  const validation = validateAnswer({
    answer: input.text,
    intent: input.intent,
    evidence: input.evidence,
  });
  if (validation.valid) return { ...input, validation };

  const escalated = input.intent === "emergency";
  if (escalated && input.metadata && typeof input.metadata.classification === "object") {
    // If deterministic safety validation ever fails for an emergency, stop
    // automation and put the dispatcher in the loop.
  }
  return {
    ...input,
    text: SAFETY_FALLBACK[input.language] ?? SAFETY_FALLBACK.en,
    validation,
    escalated,
    deliveredAmbulanceId: undefined,
    metadata: { ...(input.metadata ?? {}), validationBlockedOriginal: true },
  };
}

function locationQuery(classification: IntentClassification): string | null {
  const city = classification.extractedLocation?.city;
  const area = classification.extractedLocation?.area;
  if (city && area) return `${city} ${area}`;
  if (city) return city;
  if (area) return area;
  return null;
}

function buildEmergencyCard(row: AmbulanceRow, language: Language, coverage: CoverageStatusResult[]): string {
  const base = buildAmbulanceCard(row, language).full_message;
  const timing = coverage.find((item) => item.status === "active" && item.notes)?.notes;
  if (!timing) return base;
  return `${base}\nTimings: ${timing}`;
}

function askAreaText(language: Language, rows: AmbulanceRow[]): string {
  const examples = [...new Set(rows.map((row) => row.area).filter(Boolean))].slice(0, 3).join(", ");
  const city = rows[0]?.city ?? "that city";
  const suffix = examples ? ` E.g. ${examples}.` : "";
  const byLang: Record<Language, string> = {
    en: `Which area in ${city}?${suffix}`,
    hi: `${city} में कौन सा area?${suffix}`,
    mr: `${city} मध्ये कोणता area?${suffix}`,
    gu: `${city} માં કયો area?${suffix}`,
  };
  return byLang[language] ?? byLang.en;
}

function addCoverageFacts(evidence: EvidencePack, coverage: CoverageStatusResult[]): void {
  for (const item of coverage) {
    const key = `coverage.${item.status}.${item.city}.${item.area ?? "city"}`.toLowerCase().replace(/[^a-z0-9]+/g, "_");
    evidence.deterministicFacts.push({
      key,
      label: `${item.city}${item.area ? ` ${item.area}` : ""} coverage`,
      value: item.status,
      category: "coverage",
    });
    evidence.validationContext.allowedFactKeys.push(key);
    if (item.status === "active") evidence.validationContext.allowedCoverageClaims?.push(`${item.city} ${item.area ?? ""}`.trim());
  }
}

function selectFacts(facts: EvidenceFact[], preferredKeys: string[], limit: number): EvidenceFact[] {
  const byKey = new Map(facts.map((fact) => [fact.key, fact]));
  const selected = preferredKeys.flatMap((key) => {
    const fact = byKey.get(key);
    return fact ? [fact] : [];
  });
  for (const fact of facts) {
    if (selected.length >= limit) break;
    if (!selected.some((item) => item.key === fact.key)) selected.push(fact);
  }
  return selected.slice(0, limit);
}

function composeKnowledgeAnswer(facts: EvidenceFact[], articles: EvidencePack["articles"], language: Language): string {
  if (facts.length === 0 && articles.length === 0) return UNAVAILABLE[language] ?? UNAVAILABLE.en;
  const lines: string[] = [];
  for (const fact of facts.slice(0, 4)) lines.push(`${fact.label}: ${fact.value}`);
  for (const article of articles.slice(0, Math.max(1, 3 - lines.length))) {
    lines.push(`${article.title}: ${article.body}`);
  }
  return lines.join("\n").slice(0, 1400);
}

async function auditTool(conversationId: string, toolName: string, toolInput: unknown, toolOutput: unknown): Promise<void> {
  await audit({
    conversationId,
    actionType: "tool_call",
    toolName,
    toolInput,
    toolOutput,
  });
}

const ASK_CITY: Record<Language, string> = {
  en: "Which city is the animal in?",
  hi: "जानवर किस शहर में है?",
  mr: "प्राणी कोणत्या शहरात आहे?",
  gu: "પ્રાણી કયા શહેરમાં છે?",
};

const MEDICAL_REFUSAL: Record<Language, string> = {
  en: "We can't suggest medicine or treatment remotely. Please call the nearest ambulance or visit a vet/clinic as soon as you can.",
  hi: "हम दूर से दवा या इलाज नहीं बता सकते। कृपया नज़दीकी ambulance को कॉल करें या जल्द से जल्द vet/clinic जाएँ।",
  mr: "आम्ही दूरून औषध किंवा उपचार सांगू शकत नाही. कृपया जवळच्या ambulance ला कॉल करा किंवा लवकरात लवकर vet/clinic ला जा.",
  gu: "અમે દૂરથી દવા કે સારવાર કહી શકતા નથી. કૃપા કરીને નજીકની ambulance ને કૉલ કરો અથવા શક્ય તેટલું વહેલું vet/clinic પર જાઓ.",
};

const DONATION_HEADER: Record<Language, string> = {
  en: "Donation information verified from our current KB:",
  hi: "हमारी current KB से verified donation info:",
  mr: "आमच्या current KB मधील verified donation info:",
  gu: "અમારી current KB મુજબ verified donation info:",
};

const VOLUNTEER_HEADER: Record<Language, string> = {
  en: "Volunteer information verified from our current KB:",
  hi: "हमारी current KB से verified volunteer info:",
  mr: "आमच्या current KB मधील verified volunteer info:",
  gu: "અમારી current KB મુજબ verified volunteer info:",
};

const CONTACT_HEADER: Record<Language, string> = {
  en: "Official AlwaysCare links:",
  hi: "Official AlwaysCare links:",
  mr: "Official AlwaysCare links:",
  gu: "Official AlwaysCare links:",
};

const UNAVAILABLE: Record<Language, string> = {
  en: "I can't verify that from the current knowledge base. Please share a little more detail or ask for a human teammate.",
  hi: "मैं इसे current knowledge base से verify नहीं कर पा रहा हूँ। कृपया थोड़ा और detail शेयर करें या human teammate माँगें।",
  mr: "हे current knowledge base मधून verify होत नाही. कृपया थोडी अधिक माहिती द्या किंवा human teammate मागा.",
  gu: "હું આ current knowledge base પરથી verify કરી શકતો નથી. કૃપા કરીને થોડી વધુ detail આપો અથવા human teammate માંગો.",
};

const SAFETY_FALLBACK: Record<Language, string> = {
  en: "I need a human teammate to verify this safely before replying.",
  hi: "सुरक्षित जवाब देने से पहले human teammate से verify करना ज़रूरी है।",
  mr: "सुरक्षित उत्तर देण्यापूर्वी human teammate कडून verify करणे गरजेचे आहे.",
  gu: "સુરક્ષિત જવાબ આપવા પહેલા human teammate દ્વારા verify કરવું જરૂરી છે.",
};

const HANDOFF_ACK: Record<Language, string> = {
  en: "I've flagged this for a human teammate. Please share the city and what happened.",
  hi: "मैंने इसे human teammate के लिए flag कर दिया है। कृपया city और क्या हुआ शेयर करें।",
  mr: "मी हे human teammate साठी flag केले आहे. कृपया city आणि काय झाले ते सांगा.",
  gu: "મેં આ human teammate માટે flag કર્યું છે. કૃપા કરીને city અને શું થયું તે જણાવો.",
};

const THANKS: Record<Language, string> = {
  en: "Thank you for caring.",
  hi: "मदद करने के लिए धन्यवाद।",
  mr: "काळजी घेतल्याबद्दल धन्यवाद.",
  gu: "કાળજી લેવા બદલ આભાર.",
};

function outOfCoverageText(language: Language, place: string): string {
  const byLang: Record<Language, string> = {
    en: `We don't currently have active ambulance coverage for ${place}. For urgent help, please contact a local animal rescue group there.`,
    hi: `${place} के लिए अभी हमारी active ambulance coverage नहीं है। Urgent help के लिए वहाँ के local animal rescue group से संपर्क करें।`,
    mr: `${place} साठी सध्या active ambulance coverage नाही. Urgent help साठी तिथल्या local animal rescue group शी संपर्क करा.`,
    gu: `${place} માટે હાલ active ambulance coverage નથી. Urgent help માટે ત્યાંના local animal rescue group નો સંપર્ક કરો.`,
  };
  return byLang[language] ?? byLang.en;
}

function launchingSoonText(language: Language, place: string): string {
  const byLang: Record<Language, string> = {
    en: `${place} is marked as launching soon in our current coverage data. For urgent help today, please contact a local animal rescue group there.`,
    hi: `${place} हमारी current coverage data में launching soon है। आज urgent help के लिए वहाँ के local animal rescue group से संपर्क करें।`,
    mr: `${place} आमच्या current coverage data मध्ये launching soon आहे. आज urgent help साठी local animal rescue group शी संपर्क करा.`,
    gu: `${place} અમારી current coverage data માં launching soon છે. આજે urgent help માટે local animal rescue group નો સંપર્ક કરો.`,
  };
  return byLang[language] ?? byLang.en;
}

function activeCoverageText(language: Language, place: string, notes: string | null): string {
  const timing = notes ? ` Timings: ${notes}.` : "";
  const byLang: Record<Language, string> = {
    en: `${place} is active in our current coverage data.${timing}`,
    hi: `${place} हमारी current coverage data में active है.${timing}`,
    mr: `${place} आमच्या current coverage data मध्ये active आहे.${timing}`,
    gu: `${place} અમારી current coverage data માં active છે.${timing}`,
  };
  return byLang[language] ?? byLang.en;
}
