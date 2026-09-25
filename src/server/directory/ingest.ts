import { parse } from "csv-parse/sync";
import { eq } from "drizzle-orm";
import { getDb } from "../db/client";
import { ambulances, clinics, operators } from "../db/schema";

export interface CsvRow {
  Type: string; Name: string; City: string; Area: string; State: string; Phone: string;
  "Area of Operation": string; Category: string; "Operated By": string;
}

export const ARHAM_NAME = "Arham Yuva Seva Group";

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

export function parseDirectoryCsv(text: string): { ambulances: CsvRow[]; clinics: CsvRow[] } {
  const records = parse(text, { columns: true, skip_empty_lines: true, trim: true }) as CsvRow[];
  return {
    ambulances: records.filter((r) => r.Type === "Ambulance"),
    clinics: records.filter((r) => r.Type === "Clinic"),
  };
}

export async function ingestDirectory(rows: { ambulances: CsvRow[]; clinics: CsvRow[] }) {
  const db = getDb();
  const names = new Set([...rows.ambulances, ...rows.clinics].map((r) => r["Operated By"].trim()).filter(Boolean));
  const operatorIdByName = new Map<string, string>();
  for (const name of names) {
    const [existing] = await db.select({ id: operators.id }).from(operators).where(eq(operators.name, name));
    if (existing) { operatorIdByName.set(name, existing.id); continue; }
    const [inserted] = await db.insert(operators).values({ name, isArham: name === ARHAM_NAME }).returning({ id: operators.id });
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
    const [existing] = await db.select({ id: ambulances.id }).from(ambulances).where(eq(ambulances.label, payload.label));
    if (existing) { await db.update(ambulances).set(payload).where(eq(ambulances.id, existing.id)); ambulancesUpdated++; }
    else { await db.insert(ambulances).values(payload); ambulancesInserted++; }
  }

  for (const r of rows.clinics) {
    const operatorId = operatorIdByName.get(r["Operated By"].trim());
    if (!operatorId) throw new Error(`Missing operator for ${r.Name}`);
    const payload = {
      operatorId, label: r.Name.trim(), city: r.City.replace(/,.*$/, "").trim(), area: (r.Area ?? "").trim() || null,
      state: r.State.trim(), phone: normalizePhone(r.Phone), phoneRaw: (r.Phone ?? "").trim(), active: true,
    };
    const [existing] = await db.select({ id: clinics.id }).from(clinics).where(eq(clinics.label, payload.label));
    if (existing) { await db.update(clinics).set(payload).where(eq(clinics.id, existing.id)); clinicsUpdated++; }
    else { await db.insert(clinics).values(payload); clinicsInserted++; }
  }

  return { operators: names.size, ambulancesInserted, ambulancesUpdated, clinicsInserted, clinicsUpdated };
}
