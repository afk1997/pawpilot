import { parse } from "csv-parse/sync";
import { and, eq, notInArray } from "drizzle-orm";
import { getDb, type Db } from "../db/client";
import { ambulances, clinics, operators } from "../db/schema";
import { levenshtein } from "./fuzzy";
import { findDigitRuns, maskDigitRuns } from "../agent/scrub";
import { DEFAULT_WEBSITE_URL, MAPS_URL_RE, websitePageRe } from "../links";

export interface CsvRow {
  Type: string; Name: string; City: string; Area: string; State: string; Phone: string;
  "Area of Operation": string; Category: string; "Operated By": string;
  /**
   * Optional columns, absent from an older file and empty when unknown. Hours: when the team answers, as cards show it
   * ("10am–7pm IST"), for ambulance and clinic rows alike. The rest are a hospital's or clinic's, so they are not read on
   * an ambulance row: Address; Maps, its Google Maps location as one https link ("https://maps.google.com/?q=<lat>,<lng>",
   * coordinates rounded to 5 decimals, so no 7-digit run); Page, its page on the website, one https link; Services, what
   * it offers; Notes, what a visitor should know (charges, calling first).
   */
  Hours?: string;
  Address?: string;
  Maps?: string;
  Page?: string;
  Services?: string;
  Notes?: string;
}

export interface DirectoryRows {
  ambulances: CsvRow[];
  clinics: CsvRow[];
}

export const ARHAM_NAME = "Arham Yuva Seva Group";

/** A name as the Arham comparison reads it: lower case, with no whitespace at all. */
const nameKey = (name: string): string => (name ?? "").toLowerCase().replace(/\s+/g, "");
const ARHAM_KEY = nameKey(ARHAM_NAME);
/** A name this few edits from Arham's without being it is a misspelling of it, not a partner. */
const ARHAM_NEAR_MISS_EDITS = 2;

/** Arham's own name, whatever its case and spacing ("  ARHAM yuva seva group"). */
export function isArhamName(name: string): boolean {
  return nameKey(name) === ARHAM_KEY;
}

/** Within ARHAM_NEAR_MISS_EDITS of Arham's name but not it: stored as a partner, Arham's units would be labelled a partner's. */
function isArhamNearMiss(name: string): boolean {
  const key = nameKey(name);
  return key !== ARHAM_KEY && levenshtein(key, ARHAM_KEY) <= ARHAM_NEAR_MISS_EDITS;
}

/** The operator name as stored: Arham's in its one spelling (so Arham has one operator row), any other trimmed. */
function operatorName(raw: string): string {
  const name = (raw ?? "").trim();
  return isArhamName(name) ? ARHAM_NAME : name;
}

/** Ambulance numbers are drivers' mobiles; a clinic may list a landline. Both must be Indian. */
const AMBULANCE_PHONE = /^\+91[6-9]\d{9}$/;
const CLINIC_PHONE = /^\+91[1-9]\d{9}$/;
const REQUIRED_FIELDS = ["Name", "City", "State", "Operated By"] as const;
/** Every text cell: a phone-shaped number in one is a mistake directoryWarnings names (it is not a unit's number). */
const TEXT_FIELDS = [
  "Name", "City", "Area", "State", "Area of Operation", "Category", "Operated By", "Hours", "Address", "Maps", "Page", "Services", "Notes",
] as const;
/** What validateDirectoryRows checks a clinic's Page against: the website (WEBSITE_URL), "https://alwayscare.org" by default. */
export interface DirectoryCheckOptions {
  websiteUrl?: string;
}

/** An optional cell as stored: trimmed, null when empty or when the file has no such column. */
const optionalCell = (value: string | undefined): string | null => (value ?? "").trim() || null;

export function normalizePhone(raw: string): string {
  const digits = (raw ?? "").replace(/\D/g, "");
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith("91")) return `+${digits}`;
  if (digits.length === 11 && digits.startsWith("0")) return `+91${digits.slice(1)}`;
  return `+${digits}`;
}

export function parseAreasCovered(value: string, city: string, area: string): string[] {
  const v = (value ?? "").trim();
  if (!v) return area ? [area] : [];
  if (/^entire city$/i.test(v)) return [city];
  return v.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

/** "ALAI Trust" in the Area column is the operator, not a place. */
export function isPartnerNameLeak(area: string, operator: string): boolean {
  if (!area || !operator || isArhamName(operator)) return false;
  const a = area.trim().toLowerCase();
  const o = operator.trim().toLowerCase();
  if (a.length < 4 || o.length < 4) return false;
  return a === o || a.includes(o) || o.includes(a);
}

/** How a line names a row: kind and Name, a number in the Name masked, or the City when there is no Name. */
function rowLabel(r: CsvRow, kind: "Ambulance" | "Clinic"): string {
  const name = (r.Name ?? "").trim();
  if (!name) return `${kind} with no Name (City "${(r.City ?? "").trim()}")`;
  return `${kind} "${findDigitRuns(name).length > 0 ? maskDigitRuns(name, "[number]") : name}"`;
}

export function parseDirectoryCsv(text: string): DirectoryRows {
  // bom: an Excel "CSV UTF-8" export starts with U+FEFF, which would otherwise hide the Type column.
  const records = parse(text, { columns: true, skip_empty_lines: true, trim: true, bom: true }) as CsvRow[];
  return {
    ambulances: records.filter((r) => r.Type === "Ambulance"),
    clinics: records.filter((r) => r.Type === "Clinic"),
  };
}

/**
 * Every problem that makes the file unsafe to ingest, one line per row (empty when it is
 * safe). A line names the row and its problems; it never repeats phone digits, only
 * their count. A clinic's Maps cell must be a Google Maps link to coordinates
 * (MAPS_URL_RE: code puts it into replies as written) and its Page a page on the website.
 */
export function validateDirectoryRows(rows: DirectoryRows, options: DirectoryCheckOptions = {}): string[] {
  const errors: string[] = [];
  const websiteUrl = options.websiteUrl ?? DEFAULT_WEBSITE_URL;
  const pageRe = websitePageRe(websiteUrl);
  // Ingest deactivates every unit the file does not list, so an empty list would switch off the whole directory.
  if (rows.ambulances.length === 0) errors.push("no ambulance rows (check the header row and the Type column)");
  const firstRowByName = new Map<string, string>();

  const check = (r: CsvRow, kind: "Ambulance" | "Clinic") => {
    const name = (r.Name ?? "").trim();
    const rowName = rowLabel(r, kind);
    const problems = REQUIRED_FIELDS.filter((field) => !(r[field] ?? "").trim()).map((field) => `${field} is empty`);

    const digits = (r.Phone ?? "").replace(/\D/g, "").length;
    const pattern = kind === "Ambulance" ? AMBULANCE_PHONE : CLINIC_PHONE;
    if (digits === 0) problems.push("Phone is empty");
    else if (!pattern.test(normalizePhone(r.Phone))) {
      const expected = kind === "Ambulance" ? "an Indian mobile number: 10 digits starting 6-9" : "an Indian number: 10 digits";
      problems.push(`Phone must be ${expected}, optionally after 0, 91 or +91 (the cell has ${digits} digits)`);
    }

    // Ambulance rows have no link cells: they are not read there.
    if (kind === "Clinic") {
      const maps = (r.Maps ?? "").trim();
      if (maps && !MAPS_URL_RE.test(maps)) {
        problems.push("Maps must be a Google Maps link to coordinates, https://maps.google.com/?q=<lat>,<lng> with at most six decimals, and nothing else");
      }
      const page = (r.Page ?? "").trim();
      if (page && !pageRe.test(page)) problems.push(`Page must be a page on ${new URL(websiteUrl).origin}, with a path of letters, digits, "/", "_" and "-" only`);
    }

    const operator = (r["Operated By"] ?? "").trim();
    if (isArhamNearMiss(operator)) {
      problems.push(
        `Operated By "${operator}" is within two letters of "${ARHAM_NAME}" but is not it: spell Arham's name exactly (a partner's name is shown to reporters as the operator)`
      );
    }

    // Labels are the upsert key: a second row with the same Name would overwrite the first.
    if (name) {
      const first = firstRowByName.get(name.toLowerCase());
      if (first) problems.push(`Name is already used by ${first}`);
      else firstRowByName.set(name.toLowerCase(), rowName);
    }
    if (problems.length > 0) errors.push(`${rowName}: ${problems.join("; ")}`);
  };

  for (const r of rows.ambulances) check(r, "Ambulance");
  for (const r of rows.clinics) check(r, "Clinic");
  return errors;
}

/**
 * Rows that are safe to ingest but hold a phone-shaped number (in any script) in a text cell, one line per row naming
 * the cells, never the digits. Tool output and the prompt's coverage list drop such a run before the model sees it,
 * but code-built cards and partner labels show the unit's area, city, operator and hours as written.
 */
export function directoryWarnings(rows: DirectoryRows): string[] {
  const warnings: string[] = [];
  const check = (r: CsvRow, kind: "Ambulance" | "Clinic") => {
    const cells = TEXT_FIELDS.filter((field) => findDigitRuns(r[field] ?? "").length > 0);
    if (cells.length === 0) return;
    warnings.push(`${rowLabel(r, kind)}: ${cells.join(", ")} ${cells.length === 1 ? "holds" : "hold"} a phone-shaped number: put phone numbers only in the Phone column`);
  };
  for (const r of rows.ambulances) check(r, "Ambulance");
  for (const r of rows.clinics) check(r, "Clinic");
  return warnings;
}

/**
 * Makes the directory match the file, in one transaction: upserts operators by name and
 * ambulances and clinics by label, then deactivates every active ambulance or clinic the
 * file no longer lists (a listed row is re-activated). Hours, and a clinic's Address, Maps,
 * Page, Services and Notes, are written as the file has them, so an empty cell, or a file
 * without the column, clears them. Throws before writing anything when the file fails
 * validateDirectoryRows (with `options`); returns directoryWarnings' lines with the counts.
 */
export async function ingestDirectory(rows: DirectoryRows, db: Db = getDb(), options: DirectoryCheckOptions = {}) {
  const errors = validateDirectoryRows(rows, options);
  if (errors.length > 0) throw new Error(`CSV validation failed:\n${errors.map((e) => `- ${e}`).join("\n")}`);

  return db.transaction(async (tx) => {
    const names = new Set([...rows.ambulances, ...rows.clinics].map((r) => operatorName(r["Operated By"])).filter(Boolean));
    const operatorIdByName = new Map<string, string>();
    for (const name of names) {
      const [existing] = await tx.select({ id: operators.id }).from(operators).where(eq(operators.name, name));
      if (existing) { operatorIdByName.set(name, existing.id); continue; }
      const [inserted] = await tx.insert(operators).values({ name, isArham: isArhamName(name) }).returning({ id: operators.id });
      operatorIdByName.set(name, inserted.id);
    }

    let ambulancesInserted = 0, ambulancesUpdated = 0, clinicsInserted = 0, clinicsUpdated = 0;

    for (const r of rows.ambulances) {
      const operator = operatorName(r["Operated By"]);
      const operatorId = operatorIdByName.get(operator);
      if (!operatorId) throw new Error(`Missing operator for ${r.Name}`);
      const rawArea = (r.Area ?? "").trim();
      const leak = isPartnerNameLeak(rawArea, operator);
      const payload = {
        operatorId, label: r.Name.trim(), city: r.City.trim(), area: leak ? null : rawArea || null, state: r.State.trim(),
        phone: normalizePhone(r.Phone), phoneRaw: (r.Phone ?? "").trim(),
        areasCovered: leak ? [r.City.trim()] : parseAreasCovered(r["Area of Operation"], r.City.trim(), rawArea),
        category: (r.Category ?? "").trim() || "Animal Ambulance", hours: optionalCell(r.Hours), active: true, updatedAt: new Date(),
      };
      const [existing] = await tx.select({ id: ambulances.id }).from(ambulances).where(eq(ambulances.label, payload.label));
      if (existing) { await tx.update(ambulances).set(payload).where(eq(ambulances.id, existing.id)); ambulancesUpdated++; }
      else { await tx.insert(ambulances).values(payload); ambulancesInserted++; }
    }

    for (const r of rows.clinics) {
      const operatorId = operatorIdByName.get(operatorName(r["Operated By"]));
      if (!operatorId) throw new Error(`Missing operator for ${r.Name}`);
      const payload = {
        operatorId, label: r.Name.trim(), city: r.City.replace(/,.*$/, "").trim(), area: (r.Area ?? "").trim() || null,
        state: r.State.trim(), phone: normalizePhone(r.Phone), phoneRaw: (r.Phone ?? "").trim(),
        address: optionalCell(r.Address), hours: optionalCell(r.Hours), mapsUrl: optionalCell(r.Maps), pageUrl: optionalCell(r.Page),
        services: optionalCell(r.Services), notes: optionalCell(r.Notes), active: true,
      };
      const [existing] = await tx.select({ id: clinics.id }).from(clinics).where(eq(clinics.label, payload.label));
      if (existing) { await tx.update(clinics).set(payload).where(eq(clinics.id, existing.id)); clinicsUpdated++; }
      else { await tx.insert(clinics).values(payload); clinicsInserted++; }
    }

    // Only rows switched off by this run are counted; the clinics table has no updated_at.
    const deactivatedAmbulances = await tx
      .update(ambulances)
      .set({ active: false, updatedAt: new Date() })
      .where(and(eq(ambulances.active, true), notInArray(ambulances.label, rows.ambulances.map((r) => r.Name.trim()))))
      .returning({ label: ambulances.label });
    const deactivatedClinics = await tx
      .update(clinics)
      .set({ active: false })
      .where(and(eq(clinics.active, true), notInArray(clinics.label, rows.clinics.map((r) => r.Name.trim()))))
      .returning({ label: clinics.label });

    return {
      warnings: directoryWarnings(rows),
      operators: names.size,
      ambulancesInserted, ambulancesUpdated, ambulancesDeactivated: deactivatedAmbulances.length,
      clinicsInserted, clinicsUpdated, clinicsDeactivated: deactivatedClinics.length,
      // By name, so a unit switched off by a typo in its Type or Name cell is seen in the summary.
      deactivatedLabels: {
        ambulances: deactivatedAmbulances.map((r) => r.label).sort(),
        clinics: deactivatedClinics.map((r) => r.label).sort(),
      },
    };
  });
}
