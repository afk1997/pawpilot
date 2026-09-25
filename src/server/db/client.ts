import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema";
import { getConfig } from "../config";
import { log } from "../log";

let sqlClient: ReturnType<typeof postgres> | null = null;
let db: ReturnType<typeof drizzle<typeof schema>> | null = null;

// postgres.js console.logs server NOTICEs ("... does not exist, skipping") by default,
// which would break the structured log stream.
const onnotice = (notice: postgres.Notice) => log.debug({ notice: notice.message }, "postgres notice");

export function getSql() {
  if (!sqlClient) {
    const cfg = getConfig();
    sqlClient = postgres(cfg.databaseUrl, {
      // Room for every concurrent turn's queries plus the heartbeat and the sweeper. Advisory locks
      // hold connections of their own (openLockConnection), never pool ones.
      max: Math.max(8, 2 * cfg.workerConcurrency + 2),
      idle_timeout: 30,
      prepare: false,
      onnotice,
    });
  }
  return sqlClient;
}

/**
 * A one-connection client for a single turn's advisory lock; the caller ends it after the turn.
 * Not a reserved pool connection: once a reserved connection's backend dies, postgres.js 3.4.9
 * throws an uncaught TypeError on its next query and the process exits, while this client
 * reconnects instead (the session lock is gone with the old backend either way).
 */
export function openLockConnection() {
  return postgres(getConfig().databaseUrl, { max: 1, prepare: false, connect_timeout: 10, onnotice });
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
