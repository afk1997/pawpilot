/**
 * Ingest the Arham Always Care ambulance + clinic directory into Supabase.
 *
 * Source of truth: ambulances-clinics.csv (gitignored, contains driver personal phones).
 * Re-run this script whenever the spreadsheet changes; ingest is idempotent (upsert by label).
 *
 *   pnpm ingest:ambulances              # default: ./ambulances-clinics.csv
 *   pnpm ingest:ambulances ./other.csv  # custom path
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { config as loadEnv } from "dotenv";
import { parse } from "csv-parse/sync";
import { createClient } from "@supabase/supabase-js";

loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

const csvPath = resolve(process.argv[2] ?? "ambulances-clinics.csv");
console.log(`Reading ${csvPath}`);

type Row = {
  Type: string;
  Name: string;
  City: string;
  Area: string;
  State: string;
  Phone: string;
  "Area of Operation": string;
  Category: string;
  "Operated By": string;
};

const raw = readFileSync(csvPath, "utf8");
const records = parse(raw, { columns: true, skip_empty_lines: true, trim: true }) as Row[];

const dataRows = records.filter((r) => r.Type === "Ambulance" || r.Type === "Clinic");
const ambulances = dataRows.filter((r) => r.Type === "Ambulance");
const clinics = dataRows.filter((r) => r.Type === "Clinic");

console.log(`Parsed: ${ambulances.length} ambulances, ${clinics.length} clinics`);

/** Normalize an Indian phone like "6262 0909 15" → "+916262090915" (E.164). */
function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith("91")) return `+${digits}`;
  if (digits.length === 11 && digits.startsWith("0")) return `+91${digits.slice(1)}`;
  return digits.startsWith("+") ? digits : `+${digits}`;
}

function parseAreasCovered(value: string, city: string, area: string): string[] {
  if (!value) return area ? [area] : [];
  if (/^entire city$/i.test(value.trim())) return [city];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const ARHAM_NAME = "Arham Yuva Seva Group";

async function main() {
  // Step 1 — collect unique operators (Arham itself + each partner NGO)
  const operatorNames = new Set<string>();
  for (const r of dataRows) operatorNames.add(r["Operated By"].trim());
  console.log(`Operators: ${operatorNames.size} unique`);

  const operatorIdByName = new Map<string, string>();
  for (const name of operatorNames) {
    const isArham = name === ARHAM_NAME;
    const existing = await supabase
      .from("ngo_operators")
      .select("id")
      .eq("name", name)
      .maybeSingle();
    if (existing.data) {
      operatorIdByName.set(name, existing.data.id);
      continue;
    }
    const inserted = await supabase
      .from("ngo_operators")
      .insert({ name, is_arham: isArham })
      .select("id")
      .single();
    if (inserted.error || !inserted.data) {
      console.error(`Failed to insert operator ${name}:`, inserted.error);
      process.exit(1);
    }
    operatorIdByName.set(name, inserted.data.id);
    console.log(`  + ${name}${isArham ? " (Arham)" : ""}`);
  }

  // Step 2 — upsert ambulances
  let ambulancesInserted = 0;
  let ambulancesUpdated = 0;
  for (const r of ambulances) {
    const operatorId = operatorIdByName.get(r["Operated By"].trim());
    if (!operatorId) throw new Error(`Missing operator for ${r.Name}`);

    const payload = {
      operator_id: operatorId,
      label: r.Name.trim(),
      city: r.City.trim(),
      area: r.Area?.trim() || null,
      state: r.State.trim(),
      phone: normalizePhone(r.Phone),
      phone_raw: r.Phone.trim(),
      areas_covered: parseAreasCovered(r["Area of Operation"], r.City, r.Area || ""),
      category: r.Category?.trim() || "Animal Ambulance",
      active: true,
      updated_at: new Date().toISOString(),
    };

    const existing = await supabase
      .from("ambulances")
      .select("id")
      .eq("label", payload.label)
      .maybeSingle();
    if (existing.data) {
      const upd = await supabase.from("ambulances").update(payload).eq("id", existing.data.id);
      if (upd.error) {
        console.error(`Failed to update ambulance ${payload.label}:`, upd.error);
        process.exit(1);
      }
      ambulancesUpdated++;
    } else {
      const ins = await supabase.from("ambulances").insert(payload);
      if (ins.error) {
        console.error(`Failed to insert ambulance ${payload.label}:`, ins.error);
        process.exit(1);
      }
      ambulancesInserted++;
    }
  }
  console.log(`Ambulances: +${ambulancesInserted} new, ~${ambulancesUpdated} updated`);

  // Step 3 — upsert clinics
  let clinicsInserted = 0;
  let clinicsUpdated = 0;
  for (const r of clinics) {
    const operatorId = operatorIdByName.get(r["Operated By"].trim());
    if (!operatorId) throw new Error(`Missing operator for ${r.Name}`);

    const payload = {
      operator_id: operatorId,
      label: r.Name.trim(),
      city: r.City.replace(/,.*$/, "").trim(),
      area: r.Area?.trim() || null,
      state: r.State.trim(),
      phone: normalizePhone(r.Phone),
      phone_raw: r.Phone.trim(),
      active: true,
    };

    const existing = await supabase
      .from("clinics")
      .select("id")
      .eq("label", payload.label)
      .maybeSingle();
    if (existing.data) {
      const upd = await supabase.from("clinics").update(payload).eq("id", existing.data.id);
      if (upd.error) {
        console.error(`Failed to update clinic ${payload.label}:`, upd.error);
        process.exit(1);
      }
      clinicsUpdated++;
    } else {
      const ins = await supabase.from("clinics").insert(payload);
      if (ins.error) {
        console.error(`Failed to insert clinic ${payload.label}:`, ins.error);
        process.exit(1);
      }
      clinicsInserted++;
    }
  }
  console.log(`Clinics: +${clinicsInserted} new, ~${clinicsUpdated} updated`);

  console.log("Ingest complete.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
