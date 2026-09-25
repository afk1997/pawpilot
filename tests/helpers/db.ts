import { sql } from "drizzle-orm";
import { getDb, getSql } from "@/server/db/client";
import { conversations } from "@/server/db/schema";
import type { Language } from "@/server/types";

export async function resetDb(): Promise<void> {
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
