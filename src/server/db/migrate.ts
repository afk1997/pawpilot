import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

/**
 * Applies pending drizzle migrations to the database at `url`. Needs only the URL, not the
 * app config, so migrations run before the rest of the environment exists.
 */
export async function runMigrations(url: string): Promise<void> {
  // drizzle's bookkeeping emits "already exists, skipping" notices on every run.
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await migrate(drizzle(sql), { migrationsFolder: "src/server/db/migrations" });
  } finally {
    await sql.end();
  }
}
