import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema";
import { getConfig } from "../config";
import { log } from "../log";

let sqlClient: ReturnType<typeof postgres> | null = null;
let db: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function getSql() {
  if (!sqlClient) {
    const cfg = getConfig();
    sqlClient = postgres(cfg.databaseUrl, {
      // Each turn keeps one connection reserved for its advisory lock and runs its queries on others;
      // a pool no larger than the worker's concurrency would leave concurrent turns waiting forever.
      max: Math.max(8, 2 * cfg.workerConcurrency + 2),
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
