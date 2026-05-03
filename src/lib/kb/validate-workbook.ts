import type { ParsedWorkbook, WorkbookIssue, WorkbookValidationReport } from "./types";
import { hasPlaceholder, isValidHttpUrl, unsafeTemplateReason } from "./normalizers";

export function validateParsedWorkbook(parsed: ParsedWorkbook): WorkbookValidationReport {
  const errors: WorkbookIssue[] = [...parsed.errors];
  const warnings: WorkbookIssue[] = [...parsed.warnings];

  requireNonEmpty(parsed.ambulances.length, "missing_ambulance_rows", "Workbook must contain ambulance rows.", errors);
  requireNonEmpty(parsed.clinics.length, "missing_clinic_rows", "Workbook must contain clinic rows.", errors);
  requireNonEmpty(parsed.articles.length, "missing_kb_articles", "Workbook must produce KB articles.", errors);

  for (const link of parsed.officialLinks) {
    if (!isValidHttpUrl(link.url) && !link.url.startsWith("mailto:")) {
      errors.push({
        severity: "error",
        code: "invalid_official_link_url",
        message: "Official link must be an HTTP(S) URL or mailto URL.",
        sheet: link.sourceSheet,
        row: link.sourceRow,
        value: link.url,
      });
    }
  }

  for (const template of parsed.responseTemplates) {
    if (unsafeTemplateReason(template.template)) {
      errors.push({
        severity: "error",
        code: "unsafe_template_present",
        message: "Publishable templates may not contain dispatch-implying wording.",
        sheet: template.sourceSheet,
        row: template.sourceRow,
        value: template.scenario,
      });
    }
    if (hasPlaceholder(template.template)) {
      warnings.push({
        severity: "warning",
        code: "template_placeholder_present",
        message: "Template still contains placeholders; runtime must fill from structured evidence only.",
        sheet: template.sourceSheet,
        row: template.sourceRow,
        value: template.scenario,
      });
    }
  }

  const linkUrlByKey = new Map<string, string>();
  for (const link of parsed.officialLinks) {
    const existing = linkUrlByKey.get(link.linkKey);
    if (existing && normalizeUrl(existing) !== normalizeUrl(link.url)) {
      errors.push({
        severity: "error",
        code: "duplicate_conflicting_link",
        message: "Official link key appears with multiple URLs.",
        sheet: link.sourceSheet,
        row: link.sourceRow,
        value: link.linkKey,
      });
    }
    linkUrlByKey.set(link.linkKey, link.url);
  }

  const launching = new Set(
    parsed.coverageAreas
      .filter((area) => area.status === "launching_soon")
      .map((area) => `${area.city.toLowerCase()}|${(area.area ?? "").toLowerCase()}`)
  );
  for (const active of parsed.coverageAreas.filter((area) => area.status === "active" && area.area)) {
    const key = `${active.city.toLowerCase()}|${(active.area ?? "").toLowerCase()}`;
    if (launching.has(key)) {
      errors.push({
        severity: "error",
        code: "active_launching_soon_contradiction",
        message: "The same city/area cannot be both active and launching soon.",
        sheet: active.sourceSheet,
        row: active.sourceRow,
        value: `${active.city} ${active.area ?? ""}`.trim(),
      });
    }
  }

  return { errors, warnings };
}

function requireNonEmpty(count: number, code: string, message: string, errors: WorkbookIssue[]) {
  if (count > 0) return;
  errors.push({ severity: "error", code, message });
}

function normalizeUrl(value: string): string {
  return value.trim().replace(/\/$/, "");
}
