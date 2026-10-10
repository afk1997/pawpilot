import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../src/server/db/schema";
import { ingestDirectory, parseDirectoryCsv, type CsvRow } from "../src/server/directory/ingest";

/** Rows whose optional cell is filled, for the parse line: a file without the column shows 0. */
const filled = (rows: CsvRow[], cell: "Hours" | "Address" | "Maps") => rows.filter((r) => (r[cell] ?? "").trim() !== "").length;

// Needs only DATABASE_URL (like scripts/migrate.ts), not the rest of the app config.
async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set");
  const csvPath = resolve(process.argv[2] ?? "ambulances-clinics.csv");
  console.log(`Reading ${csvPath}`);
  const rows = parseDirectoryCsv(readFileSync(csvPath, "utf8"));
  console.log(
    `Parsed: ${rows.ambulances.length} ambulances (${filled(rows.ambulances, "Hours")} with hours), ` +
      `${rows.clinics.length} clinics (${filled(rows.clinics, "Hours")} with hours, ${filled(rows.clinics, "Address")} with an address, ` +
      `${filled(rows.clinics, "Maps")} with a map link)`
  );
  console.log(`Ingesting into ${url.replace(/:\/\/.*@/, "://***@")}`);
  const sql = postgres(url, { max: 1 });
  try {
    const { deactivatedLabels, warnings, ...counts } = await ingestDirectory(rows, drizzle(sql, { schema }));
    console.log(counts);
    for (const warning of warnings) console.warn(`Warning: ${warning}`);
    // A row whose Type or Name cell was mistyped deactivates the unit it used to be: name every one switched off.
    for (const [kind, labels] of Object.entries(deactivatedLabels)) {
      if (labels.length > 0) console.log(`Deactivated ${kind} (no longer in the file): ${labels.join("; ")}`);
    }
  } finally {
    await sql.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
