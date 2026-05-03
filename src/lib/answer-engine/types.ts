import type { Language } from "../types";

export type AnswerIntent =
  | "emergency"
  | "clinic"
  | "donation"
  | "volunteer"
  | "coverage"
  | "contact"
  | "medical_advice"
  | "complaint"
  | "human_request"
  | "org_info"
  | "services"
  | "faq"
  | "thanks"
  | "unknown";

export type Confidence = "high" | "medium" | "low";

export interface ExtractedLocation {
  city?: string;
  area?: string;
  raw?: string;
}

export interface IntentClassification {
  intent: AnswerIntent;
  confidence: Confidence;
  reason: string;
  extractedLocation?: ExtractedLocation;
}

export interface EvidenceFact {
  key: string;
  label: string;
  value: string;
  category?: string | null;
}

export interface EvidenceArticle {
  key: string;
  title: string;
  body: string;
  category?: string | null;
}

export interface EvidenceLink {
  key: string;
  label: string;
  url: string;
  notes?: string | null;
}

export interface EvidenceTemplate {
  key: string;
  scenario: string;
  intent?: string | null;
  template: string;
}

export interface EvidenceValidationContext {
  allowedPhoneNumbers: string[];
  allowedUrls: string[];
  allowedFactKeys: string[];
  allowedCoverageClaims?: string[];
}

export interface EvidencePack {
  intent: AnswerIntent;
  language: Language;
  confidence: Confidence;
  deterministicFacts: EvidenceFact[];
  officialLinks: EvidenceLink[];
  articles: EvidenceArticle[];
  templates: EvidenceTemplate[];
  forbiddenClaims: string[];
  validationContext: EvidenceValidationContext;
}

export interface AnswerValidationInput {
  answer: string;
  intent: AnswerIntent;
  evidence: EvidencePack;
}

export interface AnswerValidationResult {
  valid: boolean;
  warnings: string[];
}
