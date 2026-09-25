import { parse } from "csv-parse/sync";
import { and, eq, notInArray } from "drizzle-orm";
import { getDb, type Db } from "../db/client";
import { ambulances, clinics, operators } from "../db/schema";

export interface CsvRow {
  Type: string; Name: string; City: string; Area: string; State: string; Phone: string;
  "Area of Operation": string; Category: string; "Operated By": string;
}

export interface DirectoryRows {
  ambulances: CsvRow[];
  clinics: CsvRow[];
}

export const ARHAM_NAME = "Arham Yuva Seva Group";

/** Ambulance numbers are drivers' mobiles; a clinic may list a landline. Both must be Indian. */
const AMBULANCE_PHONE = /^\+91[6-9]\d{9}$/;
const CLINIC_PHONE = /^\+91[1-9]\d{9}$/;
const REQUIRED_FIELDS = ["Name", "City", "State", "Operated By"] as const;

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
  if (!area || !operator || operator === ARHAM_NAME) return false;
  const a = area.trim().toLowerCase();
  const o = operator.trim().toLowerCase();
  if (a.length < 4 || o.length < 4) return false;
  return a === o || a.includes(o) || o.includes(a);
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
 * their count.
 */
export function validateDirectoryRows(rows: DirectoryRows): string[] {
  const errors: string[] = [];
  // Ingest deactivates every unit the file does not list, so an empty list would switch off the whole directory.
  if (rows.ambulances.length === 0) errors.push("no ambulance rows (check the header row and the Type column)");
  const firstRowByName = new Map<string, string>();

  const check = (r: CsvRow, kind: "Ambulance" | "Clinic") => {
    const name = (r.Name ?? "").trim();
    const rowName = name ? `${kind} "${name}"` : `${kind} with no Name (City "${(r.City ?? "").trim()}")`;
    const problems = REQUIRED_FIELDS.filter((field) => !(r[field] ?? "").trim()).map((field) => `${field} is empty`);

    const digits = (r.Phone ?? "").replace(/\D/g, "").length;
    const pattern = kind === "Ambulance" ? AMBULANCE_PHONE : CLINIC_PHONE;
    if (digits === 0) problems.push("Phone is empty");
    else if (!pattern.test(normalizePhone(r.Phone))) {
      const expected = kind === "Ambulance" ? "an Indian mobile number: 10 digits starting 6-9" : "an Indian number: 10 digits";
      problems.push(`Phone must be ${expected}, optionally after 0, 91 or +91 (the cell has ${digits} digits)`);
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
 * Makes the directory match the file, in one transaction: upserts operators by name and
 * ambulances and clinics by label, then deactivates every active ambulance or clinic the
 * file no longer lists (a listed row is re-activated). Throws before writing anything when
 * the file fails validateDirectoryRows.
 */
export async function ingestDirectory(rows: DirectoryRows, db: Db = getDb()) {
  const errors = validateDirectoryRows(rows);
  if (errors.length > 0) throw new Error(`CSV validation failed:\n${errors.map((e) => `- ${e}`).join("\n")}`);

  return db.transaction(async (tx) => {
    const names = new Set([...rows.ambulances, ...rows.clinics].map((r) => r["Operated By"].trim()).filter(Boolean));
    const operatorIdByName = new Map<string, string>();
    for (const name of names) {
      const [existing] = await tx.select({ id: operators.id }).from(operators).where(eq(operators.name, name));
      if (existing) { operatorIdByName.set(name, existing.id); continue; }
      const [inserted] = await tx.insert(operators).values({ name, isArham: name === ARHAM_NAME }).returning({ id: operators.id });
      operatorIdByName.set(name, inserted.id);
    }

    let ambulancesInserted = 0, ambulancesUpdated = 0, clinicsInserted = 0, clinicsUpdated = 0;

    for (const r of rows.ambulances) {
      const operatorName = r["Operated By"].trim();
      const operatorId = operatorIdByName.get(operatorName);
      if (!operatorId) throw new Error(`Missing operator for ${r.Name}`);
      const rawArea = (r.Area ?? "").trim();
      const leak = isPartnerNameLeak(rawArea, operatorName);
      const payload = {
        operatorId, label: r.Name.trim(), city: r.City.trim(), area: leak ? null : rawArea || null, state: r.State.trim(),
        phone: normalizePhone(r.Phone), phoneRaw: (r.Phone ?? "").trim(),
        areasCovered: leak ? [r.City.trim()] : parseAreasCovered(r["Area of Operation"], r.City.trim(), rawArea),
        category: (r.Category ?? "").trim() || "Animal Ambulance", active: true, updatedAt: new Date(),
      };
      const [existing] = await tx.select({ id: ambulances.id }).from(ambulances).where(eq(ambulances.label, payload.label));
      if (existing) { await tx.update(ambulances).set(payload).where(eq(ambulances.id, existing.id)); ambulancesUpdated++; }
      else { await tx.insert(ambulances).values(payload); ambulancesInserted++; }
    }

    for (const r of rows.clinics) {
      const operatorId = operatorIdByName.get(r["Operated By"].trim());
      if (!operatorId) throw new Error(`Missing operator for ${r.Name}`);
      const payload = {
        operatorId, label: r.Name.trim(), city: r.City.replace(/,.*$/, "").trim(), area: (r.Area ?? "").trim() || null,
        state: r.State.trim(), phone: normalizePhone(r.Phone), phoneRaw: (r.Phone ?? "").trim(), active: true,
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
      .returning({ id: ambulances.id });
    const deactivatedClinics = await tx
      .update(clinics)
      .set({ active: false })
      .where(and(eq(clinics.active, true), notInArray(clinics.label, rows.clinics.map((r) => r.Name.trim()))))
      .returning({ id: clinics.id });

    return {
      operators: names.size,
      ambulancesInserted, ambulancesUpdated, ambulancesDeactivated: deactivatedAmbulances.length,
      clinicsInserted, clinicsUpdated, clinicsDeactivated: deactivatedClinics.length,
    };
  });
}
