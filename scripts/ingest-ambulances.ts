import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { closeDb } from "../src/server/db/client";
import { ingestDirectory, parseDirectoryCsv } from "../src/server/directory/ingest";

async function main() {
  const csvPath = resolve(process.argv[2] ?? "ambulances-clinics.csv");
  console.log(`Reading ${csvPath}`);
  const rows = parseDirectoryCsv(readFileSync(csvPath, "utf8"));
  console.log(`Parsed: ${rows.ambulances.length} ambulances, ${rows.clinics.length} clinics`);
  const result = await ingestDirectory(rows);
  console.log(result);
  await closeDb();
}

main().catch((e) => { console.error(e); process.exit(1); });
