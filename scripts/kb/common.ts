import { config as loadEnv } from "dotenv";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { ParsedWorkbook, WorkbookIssue, WorkbookValidationReport } from "../../src/lib/kb/types";

export const DEFAULT_WORKBOOK_PATH =
  "/Users/kaivan108icloud.com/Downloads/Alwayscare_WhatsApp_AI_Knowledge_Base.xlsx";

export type JsonRecord = Record<string, unknown>;

export function loadLocalEnv(): void {
  loadEnv({ path: ".env.local" });
  loadEnv({ path: ".env" });
}

export function getServiceSupabase(): SupabaseClient {
  loadLocalEnv();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local");
  }
  return createClient(url, key);
}

export function printValidationReport(report: WorkbookValidationReport): void {
  if (report.errors.length === 0 && report.warnings.length === 0) {
    console.log("Validation clean: no errors or warnings.");
    return;
  }
  for (const issue of [...report.errors, ...report.warnings]) {
    console.log(formatIssue(issue));
  }
}

export function formatIssue(issue: WorkbookIssue): string {
  const loc = [issue.sheet, issue.row ? `row ${issue.row}` : ""].filter(Boolean).join(" ");
  const value = issue.value ? ` (${issue.value})` : "";
  return `${issue.severity.toUpperCase()} ${issue.code}${loc ? ` at ${loc}` : ""}: ${issue.message}${value}`;
}

export function workbookSummary(parsed: ParsedWorkbook): JsonRecord {
  return {
    fileName: parsed.source.fileName,
    fileHash: parsed.source.fileHash,
    articles: parsed.articles.length,
    chunks: parsed.chunks.length,
    facts: parsed.facts.length,
    officialLinks: parsed.officialLinks.length,
    responseTemplates: parsed.responseTemplates.length,
    escalationRules: parsed.escalationRules.length,
    coverageAreas: parsed.coverageAreas.length,
    ambulances: parsed.ambulances.length,
    clinics: parsed.clinics.length,
    warnings: parsed.warnings.length,
    errors: parsed.errors.length,
  };
}

export function stagedRecords(parsed: ParsedWorkbook): Array<{
  record_type: string;
  natural_key: string;
  payload: JsonRecord;
}> {
  return [
    ...parsed.articles.map((payload) => ({
      record_type: "article",
      natural_key: payload.articleKey,
      payload: payload as unknown as JsonRecord,
    })),
    ...parsed.chunks.map((payload) => ({
      record_type: "chunk",
      natural_key: `${payload.articleKey}:${payload.chunkIndex}`,
      payload: payload as unknown as JsonRecord,
    })),
    ...parsed.facts.map((payload) => ({
      record_type: "fact",
      natural_key: payload.factKey,
      payload: payload as unknown as JsonRecord,
    })),
    ...parsed.officialLinks.map((payload) => ({
      record_type: "official_link",
      natural_key: payload.linkKey,
      payload: payload as unknown as JsonRecord,
    })),
    ...parsed.responseTemplates.map((payload) => ({
      record_type: "response_template",
      natural_key: payload.templateKey,
      payload: payload as unknown as JsonRecord,
    })),
    ...parsed.escalationRules.map((payload) => ({
      record_type: "escalation_rule",
      natural_key: payload.ruleKey,
      payload: payload as unknown as JsonRecord,
    })),
    ...parsed.coverageAreas.map((payload) => ({
      record_type: "coverage_area",
      natural_key: payload.coverageKey,
      payload: payload as unknown as JsonRecord,
    })),
    ...parsed.ambulances.map((payload) => ({
      record_type: "ambulance",
      natural_key: [
        payload.label,
        payload.category,
        payload.operatedBy,
        payload.phone,
        payload.sourceRow,
      ].join("|"),
      payload: payload as unknown as JsonRecord,
    })),
    ...parsed.clinics.map((payload) => ({
      record_type: "clinic",
      natural_key: [payload.label, payload.operatedBy, payload.phone, payload.sourceRow].join("|"),
      payload: payload as unknown as JsonRecord,
    })),
  ];
}

export function chunkArray<T>(items: T[], size = 250): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}
