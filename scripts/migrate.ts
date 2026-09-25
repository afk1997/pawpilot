import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { getDb, closeDb } from "../src/server/db/client";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set");
  console.log(`Migrating ${url.replace(/:\/\/.*@/, "://***@")}`);
  await migrate(getDb(), { migrationsFolder: "src/server/db/migrations" });
  console.log("Migrations applied.");
  await closeDb();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
