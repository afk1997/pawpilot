import { sql } from "drizzle-orm";
import { getDb, getSql } from "@/server/db/client";
import { conversations } from "@/server/db/schema";
import type { Language } from "@/server/types";

/** resetDb truncates every table: it refuses a database that is not a test one, such as a mistyped TEST_DATABASE_URL. */
export function assertTestDatabase(name: string): void {
  if (!name.endsWith("_test")) throw new Error(`resetDb refuses database "${name}": its name must end in _test`);
}

export async function resetDb(): Promise<void> {
  const [{ name }] = await getSql()<{ name: string }[]>`select current_database() as name`;
  assertTestDatabase(name);
  await getSql().unsafe(
    "truncate table messages, turns, events, conversations, clinics, ambulances, operators, worker_state restart identity cascade"
  );
  await getSql().unsafe("drop schema if exists pgboss cascade");
}

let counter = 0;
export async function createConversation(opts: {
  phone?: string;
  language?: Language | null;
  isTest?: boolean;
  mode?: "agent" | "human";
  welcomedAt?: Date | null;
} = {}) {
  counter += 1;
  const phone = opts.phone ?? `+9198765${String(10000 + counter).slice(-5)}`;
  const [row] = await getDb()
    .insert(conversations)
    .values({
      phone,
      // Only what the caller passed; everything else takes the database default.
      ...(opts.language !== undefined && { language: opts.language }),
      ...(opts.isTest !== undefined && { isTest: opts.isTest }),
      ...(opts.mode !== undefined && { mode: opts.mode }),
      ...(opts.welcomedAt !== undefined && { welcomedAt: opts.welcomedAt }),
    })
    .returning();
  return row;
}

export const rawSql = sql;
