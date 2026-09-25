import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../src/server/db/schema";
import { ingestDirectory, parseDirectoryCsv } from "../src/server/directory/ingest";

// Needs only DATABASE_URL (like scripts/migrate.ts), not the rest of the app config.
async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set");
  const csvPath = resolve(process.argv[2] ?? "ambulances-clinics.csv");
  console.log(`Reading ${csvPath}`);
  const rows = parseDirectoryCsv(readFileSync(csvPath, "utf8"));
  console.log(`Parsed: ${rows.ambulances.length} ambulances, ${rows.clinics.length} clinics`);
  console.log(`Ingesting into ${url.replace(/:\/\/.*@/, "://***@")}`);
  const sql = postgres(url, { max: 1 });
  try {
    console.log(await ingestDirectory(rows, drizzle(sql, { schema })));
  } finally {
    await sql.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
