import { existsSync } from "node:fs";
import { classifyIntent } from "../../src/lib/answer-engine/classify-intent";
import { validateAnswer } from "../../src/lib/answer-engine/validate-answer";
import type { EvidencePack } from "../../src/lib/answer-engine/types";
import { parseWorkbook } from "../../src/lib/kb/parse-workbook";
import { validateParsedWorkbook } from "../../src/lib/kb/validate-workbook";
import { DEFAULT_WORKBOOK_PATH, printValidationReport } from "./common";

const workbookPath = process.argv[2] ?? DEFAULT_WORKBOOK_PATH;

const cases = [
  { text: "injured dog in Mumbai Ghatkopar", intent: "emergency" },
  { text: "is ambulance available in Lucknow?", intent: "coverage" },
  { text: "Do I get 80G certificate if I donate?", intent: "donation" },
  { text: "I want to volunteer in Pune", intent: "volunteer" },
  { text: "What medicine dosage can I give?", intent: "medical_advice" },
  { text: "driver is not picking up", intent: "complaint" },
  { text: "मुझे एम्बुलेंस चाहिए मुंबई में", intent: "emergency" },
  { text: "મારે દાન કરવું છે", intent: "donation" },
];

let failures = 0;

for (const fixture of cases) {
  const result = classifyIntent(fixture.text);
  if (result.intent !== fixture.intent) {
    failures++;
    console.error(`Intent eval failed: "${fixture.text}" expected ${fixture.intent}, got ${result.intent}`);
  }
}

const evidence: EvidencePack = {
  intent: "emergency",
  language: "en",
  confidence: "high",
  deterministicFacts: [],
  officialLinks: [],
  articles: [],
  templates: [],
  forbiddenClaims: [],
  validationContext: {
    allowedPhoneNumbers: ["+917662005404"],
    allowedUrls: [],
    allowedFactKeys: [],
  },
};
const validation = validateAnswer({
  answer: "We're sending the team now. Call +91 99999 99999.",
  intent: "emergency",
  evidence,
});
if (validation.valid) {
  failures++;
  console.error("Answer validator eval failed: unsafe dispatch + unauthorized phone passed.");
}

if (existsSync(workbookPath)) {
  const parsed = parseWorkbook(workbookPath);
  const report = validateParsedWorkbook(parsed);
  printValidationReport(report);
  if (report.errors.length > 0) failures += report.errors.length;
}

if (failures > 0) {
  console.error(`kb:eval failed with ${failures} issue(s).`);
  process.exit(1);
}

console.log("kb:eval passed.");
