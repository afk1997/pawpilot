import { basename } from "node:path";
import * as XLSX from "xlsx";
import type {
  AmbulanceDraft,
  ClinicDraft,
  CoverageAreaDraft,
  EscalationRuleDraft,
  KBArticleDraft,
  KBFactDraft,
  OfficialLinkDraft,
  ParsedWorkbook,
  ResponseTemplateDraft,
  WorkbookIssue,
} from "./types";
import {
  chunkText,
  cleanString,
  extractEmail,
  extractFirstUrl,
  fileSha256,
  inferValueType,
  normalizePhone,
  parseCityArea,
  slugify,
  splitList,
  unsafeTemplateReason,
} from "./normalizers";

type SheetRow = Record<string, unknown>;

const SHEETS = {
  org: "2. Organization Info",
  services: "3. Services",
  ambulances: "4. Ambulances",
  clinics: "5. Clinics",
  launchingSoon: "6. Launching Soon",
  cities: "7. Cities Covered",
  faqs: "8. FAQs",
  donation: "9. Donation Info",
  volunteer: "10. Volunteer Info",
  contact: "11. Contact & Links",
  responses: "12. Agent Responses",
  escalation: "13. Escalation Rules",
} as const;

export function parseWorkbook(filePath: string): ParsedWorkbook {
  const workbook = XLSX.readFile(filePath, { cellDates: false });
  const warnings: WorkbookIssue[] = [];
  const errors: WorkbookIssue[] = [];
  const articles: KBArticleDraft[] = [];
  const facts: KBFactDraft[] = [];
  const officialLinks: OfficialLinkDraft[] = [];
  const responseTemplates: ResponseTemplateDraft[] = [];
  const escalationRules: EscalationRuleDraft[] = [];
  const coverageAreas: CoverageAreaDraft[] = [];
  const ambulances: AmbulanceDraft[] = [];
  const clinics: ClinicDraft[] = [];

  parseFieldValueSheet({
    workbook,
    sheetName: SHEETS.org,
    category: "organization",
    keyPrefix: "org",
    articles,
    facts,
    warnings,
  });

  parseServices(workbook, articles, facts, warnings);
  parseFaqs(workbook, articles);
  parseFieldValueSheet({
    workbook,
    sheetName: SHEETS.donation,
    category: "donation",
    keyPrefix: "donation",
    articles,
    facts,
    officialLinks,
    preferredLinkKeys: { "main donation link": "donate", "refund policy": "refund_cancellation" },
    preferredFactKeys: { "80g tax certificate": "donation.80g_certificate" },
    warnings,
  });
  parseFieldValueSheet({
    workbook,
    sheetName: SHEETS.volunteer,
    category: "volunteer",
    keyPrefix: "volunteer",
    articles,
    facts,
    officialLinks,
    preferredLinkKeys: { "volunteer sign-up link": "volunteer" },
    warnings,
  });
  parseContactLinks(workbook, facts, officialLinks, warnings);
  parseAmbulances(workbook, ambulances, coverageAreas, warnings, errors);
  parseClinics(workbook, clinics, warnings, errors);
  parseCitiesCovered(workbook, coverageAreas);
  parseLaunchingSoon(workbook, coverageAreas);
  parseResponseTemplates(workbook, responseTemplates, warnings);
  parseEscalationRules(workbook, escalationRules, warnings);

  const chunks = articles.flatMap((article) =>
    chunkText(`${article.title}\n\n${article.body}`).map((content, index) => ({
      articleKey: article.articleKey,
      chunkIndex: index,
      content,
      sourceSheet: article.sourceSheet,
      sourceRow: article.sourceRow,
    }))
  );

  return {
    source: {
      filePath,
      fileName: basename(filePath),
      fileHash: fileSha256(filePath),
    },
    articles,
    chunks,
    facts,
    officialLinks: dedupeLinks(officialLinks, warnings),
    responseTemplates,
    escalationRules,
    coverageAreas: dedupeCoverage(coverageAreas),
    ambulances,
    clinics,
    warnings,
    errors,
  };
}

function rows(workbook: XLSX.WorkBook, sheetName: string): SheetRow[] {
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) return [];
  return XLSX.utils.sheet_to_json<SheetRow>(sheet, { defval: "", raw: false });
}

function cell(row: SheetRow, key: string): string {
  return cleanString(row[key]);
}

function parseFieldValueSheet(input: {
  workbook: XLSX.WorkBook;
  sheetName: string;
  category: string;
  keyPrefix: string;
  articles: KBArticleDraft[];
  facts: KBFactDraft[];
  officialLinks?: OfficialLinkDraft[];
  preferredLinkKeys?: Record<string, string>;
  preferredFactKeys?: Record<string, string>;
  warnings: WorkbookIssue[];
}) {
  const bodyLines: string[] = [];
  rows(input.workbook, input.sheetName).forEach((row, index) => {
    const sourceRow = index + 2;
    const label = cell(row, "Field");
    const value = cell(row, "Value");
    if (!label && !value) return;
    if (!label || !value) {
      input.warnings.push({
        severity: "warning",
        code: "partial_field_value_row",
        message: "Field/value row is missing one side.",
        sheet: input.sheetName,
        row: sourceRow,
      });
      return;
    }
    const factKey = input.preferredFactKeys?.[label.toLowerCase()] ?? `${input.keyPrefix}.${slugify(label)}`;
    input.facts.push({
      factKey,
      category: input.category,
      label,
      value,
      valueType: inferValueType(value),
      sourceSheet: input.sheetName,
      sourceRow,
    });
    bodyLines.push(`${label}: ${value}`);

    const url = extractFirstUrl(value);
    if (url && input.officialLinks) {
      const preferred = input.preferredLinkKeys?.[label.toLowerCase()];
      input.officialLinks.push({
        linkKey: preferred ?? slugify(label),
        label,
        url,
        sourceSheet: input.sheetName,
        sourceRow,
      });
    }
  });

  if (bodyLines.length > 0) {
    input.articles.push({
      articleKey: `${input.keyPrefix}.summary`,
      category: input.category,
      title: titleCase(input.category),
      body: bodyLines.join("\n"),
      language: "en",
      sourceSheet: input.sheetName,
      sourceRow: 2,
    });
  }
}

function parseServices(
  workbook: XLSX.WorkBook,
  articles: KBArticleDraft[],
  facts: KBFactDraft[],
  warnings: WorkbookIssue[]
) {
  rows(workbook, SHEETS.services).forEach((row, index) => {
    const sourceRow = index + 2;
    const service = cell(row, "Service");
    const description = cell(row, "Description");
    const cost = cell(row, "Cost");
    const availability = cell(row, "Availability");
    if (!service) return;
    const key = `services.${slugify(service)}`;
    if (/chairtable/i.test(cost)) {
      warnings.push({
        severity: "warning",
        code: "suspicious_copy",
        message: "Cost field may contain a spelling issue.",
        sheet: SHEETS.services,
        row: sourceRow,
        value: cost,
      });
    }
    articles.push({
      articleKey: key,
      category: "services",
      title: service,
      body: [`Description: ${description}`, cost && `Cost: ${cost}`, availability && `Availability: ${availability}`]
        .filter(Boolean)
        .join("\n"),
      language: "en",
      sourceSheet: SHEETS.services,
      sourceRow,
    });
    if (cost) {
      facts.push({
        factKey: `${key}.cost`,
        category: "services",
        label: `${service} cost`,
        value: cost,
        valueType: inferValueType(cost),
        sourceSheet: SHEETS.services,
        sourceRow,
      });
    }
    if (availability) {
      facts.push({
        factKey: `${key}.availability`,
        category: "services",
        label: `${service} availability`,
        value: availability,
        valueType: "text",
        sourceSheet: SHEETS.services,
        sourceRow,
      });
    }
  });
}

function parseFaqs(workbook: XLSX.WorkBook, articles: KBArticleDraft[]) {
  rows(workbook, SHEETS.faqs).forEach((row, index) => {
    const question = cell(row, "Question");
    const answer = cell(row, "Answer");
    if (!question || !answer) return;
    articles.push({
      articleKey: `faq.${slugify(question).slice(0, 80)}`,
      category: "faq",
      title: question,
      body: answer,
      language: "en",
      sourceSheet: SHEETS.faqs,
      sourceRow: index + 2,
    });
  });
}

function parseContactLinks(
  workbook: XLSX.WorkBook,
  facts: KBFactDraft[],
  officialLinks: OfficialLinkDraft[],
  warnings: WorkbookIssue[]
) {
  rows(workbook, SHEETS.contact).forEach((row, index) => {
    const sourceRow = index + 2;
    const label = cell(row, "Type");
    const detail = cell(row, "Detail");
    if (!label || !detail) return;
    const key = contactLinkKey(label);

    facts.push({
      factKey: `contact.${key}`,
      category: "contact",
      label,
      value: detail,
      valueType: inferValueType(detail),
      sourceSheet: SHEETS.contact,
      sourceRow,
    });

    if (/helpline|hq whatsapp/i.test(label)) {
      warnings.push({
        severity: "warning",
        code: "helpline_not_user_call_target",
        message: "HQ WhatsApp number is retained as a fact only; it should not be shared as a call target.",
        sheet: SHEETS.contact,
        row: sourceRow,
      });
      return;
    }

    const url = extractFirstUrl(detail);
    if (url) {
      officialLinks.push({ linkKey: key, label, url, sourceSheet: SHEETS.contact, sourceRow });
      return;
    }
    const email = extractEmail(detail);
    if (email) {
      officialLinks.push({
        linkKey: key,
        label,
        url: `mailto:${email}`,
        sourceSheet: SHEETS.contact,
        sourceRow,
      });
    }
  });
}

function parseAmbulances(
  workbook: XLSX.WorkBook,
  ambulances: AmbulanceDraft[],
  coverageAreas: CoverageAreaDraft[],
  warnings: WorkbookIssue[],
  errors: WorkbookIssue[]
) {
  rows(workbook, SHEETS.ambulances).forEach((row, index) => {
    const sourceRow = index + 2;
    const location = cell(row, "Location");
    const cityShort = cell(row, "City (Short)");
    const { city, area } = parseCityArea(location, cityShort);
    const state = cell(row, "State");
    const phoneRaw = cell(row, "Contact Number");
    const phone = normalizePhone(phoneRaw);
    const operatedBy = cell(row, "Operated By");
    const category = cell(row, "Category") || "Animal Ambulance";
    const areasCovered = parseAreasCovered(cell(row, "Area of Operations"), city, area);
    if (!location || !city || !state || !phoneRaw || !operatedBy) {
      errors.push({
        severity: "error",
        code: "missing_required_ambulance_field",
        message: "Ambulance row is missing location, city, state, phone, or operator.",
        sheet: SHEETS.ambulances,
        row: sourceRow,
      });
      return;
    }
    if (!phone) {
      errors.push({
        severity: "error",
        code: "invalid_ambulance_phone",
        message: "Ambulance phone must normalize to an Indian E.164 number.",
        sheet: SHEETS.ambulances,
        row: sourceRow,
        value: phoneRaw,
      });
      return;
    }

    const label = area ? `${city} - ${area}` : city;
    ambulances.push({
      label,
      category,
      city,
      area,
      state,
      phone,
      phoneRaw,
      operatedBy,
      numberPlate: cell(row, "Number Plate") || null,
      areasCovered,
      timings: cell(row, "Timings") || null,
      sourceSheet: SHEETS.ambulances,
      sourceRow,
    });
    coverageAreas.push({
      coverageKey: `active.${slugify(city)}.${slugify(area ?? "city")}`,
      city,
      area,
      state,
      status: "active",
      aliases: areasCovered,
      notes: cell(row, "Timings") || null,
      sourceSheet: SHEETS.ambulances,
      sourceRow,
    });
    if (areasCovered.length === 0) {
      warnings.push({
        severity: "warning",
        code: "empty_ambulance_area_operations",
        message: "Ambulance has no area coverage list.",
        sheet: SHEETS.ambulances,
        row: sourceRow,
      });
    }
  });
}

function parseClinics(
  workbook: XLSX.WorkBook,
  clinics: ClinicDraft[],
  warnings: WorkbookIssue[],
  errors: WorkbookIssue[]
) {
  rows(workbook, SHEETS.clinics).forEach((row, index) => {
    const sourceRow = index + 2;
    const label = cell(row, "Clinic Name / Location");
    const state = cell(row, "State");
    const phoneRaw = cell(row, "Contact Number");
    const phone = normalizePhone(phoneRaw);
    const operatedBy = cell(row, "Operated By") || "Arham Yuva Seva Group";
    const parsed = parseClinicLocation(label);
    if (!label || !state || !phoneRaw) {
      errors.push({
        severity: "error",
        code: "missing_required_clinic_field",
        message: "Clinic row is missing label, state, or phone.",
        sheet: SHEETS.clinics,
        row: sourceRow,
      });
      return;
    }
    if (!phone) {
      errors.push({
        severity: "error",
        code: "invalid_clinic_phone",
        message: "Clinic phone must normalize to an Indian E.164 number.",
        sheet: SHEETS.clinics,
        row: sourceRow,
        value: phoneRaw,
      });
      return;
    }
    if (!parsed.city) {
      warnings.push({
        severity: "warning",
        code: "clinic_city_inferred_from_label",
        message: "Clinic city was inferred from the clinic label.",
        sheet: SHEETS.clinics,
        row: sourceRow,
      });
    }
    clinics.push({
      label,
      city: parsed.city || label.replace(/\s*-.*/, ""),
      area: parsed.area,
      state,
      phone,
      phoneRaw,
      operatedBy,
      timings: cell(row, "Timings") || null,
      sourceSheet: SHEETS.clinics,
      sourceRow,
    });
  });
}

function parseCitiesCovered(workbook: XLSX.WorkBook, coverageAreas: CoverageAreaDraft[]) {
  rows(workbook, SHEETS.cities).forEach((row, index) => {
    const sourceRow = index + 2;
    const state = cell(row, "State");
    for (const item of splitList(cell(row, "Cities / Areas Covered"))) {
      const { city, area } = parseCoveredCityItem(item);
      coverageAreas.push({
        coverageKey: `active.${slugify(city)}.${slugify(area ?? "city")}`,
        city,
        area,
        state,
        status: "active",
        aliases: area ? [area] : [],
        sourceSheet: SHEETS.cities,
        sourceRow,
      });
    }
  });
}

function parseLaunchingSoon(workbook: XLSX.WorkBook, coverageAreas: CoverageAreaDraft[]) {
  rows(workbook, SHEETS.launchingSoon).forEach((row, index) => {
    const location = cell(row, "Location");
    if (!location) return;
    const { city, area } = parseCityArea(location);
    coverageAreas.push({
      coverageKey: `launching_soon.${slugify(city)}.${slugify(area ?? "city")}`,
      city,
      area,
      state: cell(row, "State"),
      status: "launching_soon",
      aliases: [],
      notes: cell(row, "Status") || null,
      sourceSheet: SHEETS.launchingSoon,
      sourceRow: index + 2,
    });
  });
}

function parseResponseTemplates(
  workbook: XLSX.WorkBook,
  responseTemplates: ResponseTemplateDraft[],
  warnings: WorkbookIssue[]
) {
  rows(workbook, SHEETS.responses).forEach((row, index) => {
    const sourceRow = index + 2;
    const scenario = cell(row, "Scenario / Trigger");
    const template = cell(row, "Recommended Response Template");
    if (!scenario || !template) return;
    const unsafe = unsafeTemplateReason(template);
    if (unsafe) {
      warnings.push({
        severity: "warning",
        code: "unsafe_template_skipped",
        message: "Template contains dispatch-implying language and was excluded from publishable templates.",
        sheet: SHEETS.responses,
        row: sourceRow,
        value: scenario,
      });
      return;
    }
    responseTemplates.push({
      templateKey: `template.${slugify(scenario)}`,
      scenario,
      intent: inferTemplateIntent(scenario),
      language: "en",
      template,
      sourceSheet: SHEETS.responses,
      sourceRow,
    });
  });
}

function parseEscalationRules(
  workbook: XLSX.WorkBook,
  escalationRules: EscalationRuleDraft[],
  warnings: WorkbookIssue[]
) {
  rows(workbook, SHEETS.escalation).forEach((row, index) => {
    const sourceRow = index + 2;
    const trigger = cell(row, "Trigger / Condition");
    const action = cell(row, "Action");
    const routeTo = cell(row, "Who to Route To (Internal)");
    if (!trigger || !action) return;
    if (unsafeTemplateReason(action)) {
      warnings.push({
        severity: "warning",
        code: "unsafe_internal_escalation_copy",
        message: "Internal escalation action contains dispatch-like wording; runtime safety rules override it.",
        sheet: SHEETS.escalation,
        row: sourceRow,
        value: trigger,
      });
    }
    escalationRules.push({
      ruleKey: `escalation.${slugify(trigger).slice(0, 80)}`,
      trigger,
      action,
      routeTo,
      sourceSheet: SHEETS.escalation,
      sourceRow,
    });
  });
}

function parseAreasCovered(value: string, city: string, area: string | null): string[] {
  if (!value) return area ? [area] : [city];
  if (/^entire city$/i.test(value)) return [city];
  return splitList(value);
}

function parseClinicLocation(label: string): { city: string; area: string | null } {
  const location = label.replace(/\s*-\s*Arham Always Care Clinic\s*$/i, "");
  const cleaned = cleanString(location);
  if (/pawandham kandivali/i.test(cleaned)) return { city: "Mumbai", area: "Pawandham Kandivali" };
  if (/ghatkopar/i.test(cleaned)) return { city: "Mumbai", area: "Ghatkopar" };
  return { city: cleaned.replace(/\s*-.*/, ""), area: null };
}

function parseCoveredCityItem(item: string): { city: string; area: string | null } {
  const paren = item.match(/^(.+?)\s*\((.+)\)$/);
  if (paren) return { city: cleanString(paren[1]), area: cleanString(paren[2]) };
  const dashed = item.match(/^(.+?)\s+-\s+(.+)$/);
  if (dashed) return { city: cleanString(dashed[1]), area: cleanString(dashed[2]) };
  return { city: cleanString(item), area: null };
}

function contactLinkKey(label: string): string {
  const lower = label.toLowerCase();
  if (lower.includes("donate")) return "donate";
  if (lower.includes("find ambulance")) return "find_ambulance";
  if (lower.includes("find clinic")) return "find_clinic";
  if (lower.includes("live impact")) return "live_impact";
  if (lower.includes("volunteer")) return "volunteer";
  if (lower.includes("privacy")) return "privacy_policy";
  if (lower.includes("terms")) return "terms_conditions";
  if (lower.includes("refund")) return "refund_cancellation";
  if (lower.includes("email")) return "email_support";
  return slugify(label);
}

function inferTemplateIntent(scenario: string): string {
  const value = scenario.toLowerCase();
  if (value.includes("donation") || value.includes("80g")) return "donation";
  if (value.includes("volunteer")) return "volunteer";
  if (value.includes("clinic")) return "clinic";
  if (value.includes("coverage") || value.includes("city")) return "coverage";
  if (value.includes("thank")) return "thanks";
  if (value.includes("fallback")) return "unknown";
  return "general";
}

function dedupeLinks(links: OfficialLinkDraft[], warnings: WorkbookIssue[]): OfficialLinkDraft[] {
  const byKey = new Map<string, OfficialLinkDraft>();
  for (const link of links) {
    const existing = byKey.get(link.linkKey);
    if (!existing) {
      byKey.set(link.linkKey, link);
      continue;
    }
    if (existing.url.replace(/\/$/, "") !== link.url.replace(/\/$/, "")) {
      warnings.push({
        severity: "warning",
        code: "duplicate_conflicting_link",
        message: "Duplicate official link key has conflicting URLs.",
        sheet: link.sourceSheet,
        row: link.sourceRow,
        value: link.linkKey,
      });
    }
  }
  return [...byKey.values()];
}

function dedupeCoverage(coverageAreas: CoverageAreaDraft[]): CoverageAreaDraft[] {
  const byKey = new Map<string, CoverageAreaDraft>();
  for (const area of coverageAreas) {
    const existing = byKey.get(area.coverageKey);
    if (!existing) {
      byKey.set(area.coverageKey, area);
      continue;
    }
    byKey.set(area.coverageKey, {
      ...existing,
      aliases: [...new Set([...existing.aliases, ...area.aliases])],
      notes: existing.notes ?? area.notes,
    });
  }
  return [...byKey.values()];
}

function titleCase(value: string): string {
  return value.replace(/\b\w/g, (char) => char.toUpperCase());
}
