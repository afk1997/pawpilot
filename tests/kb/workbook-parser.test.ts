import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseWorkbook } from "../../src/lib/kb/parse-workbook";
import { validateParsedWorkbook } from "../../src/lib/kb/validate-workbook";

const workbookPath = "/Users/kaivan108icloud.com/Downloads/Alwayscare_WhatsApp_AI_Knowledge_Base.xlsx";

describe("parseWorkbook", () => {
  it.skipIf(!existsSync(workbookPath))("maps the AlwaysCare workbook into publishable KB records", () => {
    const parsed = parseWorkbook(workbookPath);

    expect(parsed.articles.length).toBeGreaterThan(20);
    expect(parsed.facts.some((fact) => fact.factKey === "donation.80g_certificate")).toBe(true);
    expect(parsed.officialLinks.some((link) => link.linkKey === "donate")).toBe(true);
    expect(parsed.ambulances.length).toBeGreaterThan(40);
    expect(parsed.clinics.length).toBe(5);
  });

  it.skipIf(!existsSync(workbookPath))("excludes unsafe dispatch-implying templates from publishable templates", () => {
    const parsed = parseWorkbook(workbookPath);
    const templateText = parsed.responseTemplates.map((template) => template.template).join("\n");

    expect(templateText).not.toMatch(/we'?re on it|team will reach|dispatch/i);
    expect(parsed.warnings.some((warning) => warning.code === "unsafe_template_skipped")).toBe(true);
  });
});

describe("validateParsedWorkbook", () => {
  it.skipIf(!existsSync(workbookPath))("accepts the provided workbook after unsafe templates are excluded", () => {
    const parsed = parseWorkbook(workbookPath);
    const report = validateParsedWorkbook(parsed);

    expect(report.errors).toEqual([]);
    expect(report.warnings.length).toBeGreaterThan(0);
  });
});
