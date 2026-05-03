import type { AnswerValidationInput, AnswerValidationResult } from "./types";

const DISPATCH_PROMISE =
  /\b(we'?re sending|we are sending|team will reach|our team will reach|on the way|ambulance is coming|driver is coming|will arrive|confirm dispatch|dispatch(?:ed|ing)?)\b/i;
const PLACEHOLDER =
  /\b(todo|tbd|fixme|lorem ipsum|coming soon placeholder)\b|{[A-Z0-9_ -]+}|\[[A-Z0-9_ -]+\]/i;
const INTERNAL_METADATA = /\b(sheet\s*\d+|source row|source_sheet|source version|kb_|internal only)\b/i;
const DONATION_CLAIM = /\b(80g|tax certificate|refund|razorpay|upi|recurring|monthly giving|csr|corporate support|payment gateway)\b/i;
const ACTIVE_COVERAGE_CLAIM = /\b(we (operate|serve|cover)|service is available|ambulance is available|available in|covered city)\b/i;

export function validateAnswer(input: AnswerValidationInput): AnswerValidationResult {
  const warnings = new Set<string>();
  const answer = input.answer.trim();

  if (PLACEHOLDER.test(answer)) warnings.add("placeholder_content");
  if (DISPATCH_PROMISE.test(answer)) warnings.add("unsafe_dispatch_language");
  if (INTERNAL_METADATA.test(answer)) warnings.add("internal_metadata_exposed");

  const allowedPhones = new Set(
    input.evidence.validationContext.allowedPhoneNumbers.map(normalizePhone).filter(Boolean)
  );
  for (const phone of extractPhoneCandidates(answer)) {
    const normalized = normalizePhone(phone);
    if (normalized && !allowedPhones.has(normalized)) warnings.add("unauthorized_phone_number");
  }

  const allowedUrls = new Set(input.evidence.validationContext.allowedUrls.map(normalizeUrl));
  for (const url of extractUrls(answer)) {
    if (!allowedUrls.has(normalizeUrl(url))) warnings.add("unauthorized_url");
  }

  if (input.intent === "coverage" && ACTIVE_COVERAGE_CLAIM.test(answer)) {
    const allowedCoverageClaims = input.evidence.validationContext.allowedCoverageClaims ?? [];
    if (allowedCoverageClaims.length === 0) warnings.add("unbacked_active_coverage_claim");
  }

  if (input.intent === "donation" && DONATION_CLAIM.test(answer)) {
    const allowedFactKeys = input.evidence.validationContext.allowedFactKeys;
    const hasDonationEvidence = allowedFactKeys.some((key) => key.startsWith("donation."));
    if (!hasDonationEvidence) warnings.add("unbacked_donation_claim");
  }

  return { valid: warnings.size === 0, warnings: [...warnings] };
}

export function extractPhoneCandidates(text: string): string[] {
  const matches = text.match(/(?:\+?\d[\d\s().-]{8,}\d)/g) ?? [];
  return matches.filter((candidate) => normalizePhone(candidate) !== null);
}

export function normalizePhone(value: string): string | null {
  const digits = value.replace(/\D/g, "");
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith("91")) return `+${digits}`;
  if (digits.length === 11 && digits.startsWith("0")) return `+91${digits.slice(1)}`;
  return null;
}

export function extractUrls(text: string): string[] {
  return (text.match(/https?:\/\/[^\s<>)]+/gi) ?? []).map((url) => url.replace(/[.,;!?]+$/, ""));
}

function normalizeUrl(value: string): string {
  return value.trim().replace(/[.,;!?]+$/, "").replace(/\/$/, "");
}
