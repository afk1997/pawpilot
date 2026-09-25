import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema";
import { getConfig } from "../config";
import { log } from "../log";

let sqlClient: ReturnType<typeof postgres> | null = null;
let db: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function getSql() {
  if (!sqlClient) {
    sqlClient = postgres(getConfig().databaseUrl, {
      max: 8,
      idle_timeout: 30,
      prepare: false,
      // postgres.js console.logs server NOTICEs ("... does not exist, skipping") by default,
      // which would break the structured log stream.
      onnotice: (notice) => log.debug({ notice: notice.message }, "postgres notice"),
    });
  }
  return sqlClient;
}

export function getDb() {
  if (!db) db = drizzle(getSql(), { schema });
  return db;
}

export async function closeDb(): Promise<void> {
  if (sqlClient) await sqlClient.end({ timeout: 5 });
  sqlClient = null;
  db = null;
}

export type Db = ReturnType<typeof getDb>;
