import { eq, sql } from "drizzle-orm";
import { getDb } from "../db/client";
import { workerState } from "../db/schema";

async function ensureRow() {
  await getDb().insert(workerState).values({ singleton: true }).onConflictDoNothing();
}

export async function getWorkerState() {
  await ensureRow();
  const [row] = await getDb().select().from(workerState).where(eq(workerState.singleton, true));
  return {
    claudePausedUntil: row.claudePausedUntil,
    pauseReason: row.pauseReason,
    lastHeartbeatAt: row.lastHeartbeatAt,
    lastOkTurnAt: row.lastOkTurnAt,
  };
}

export async function isClaudePaused(now: Date = new Date()): Promise<boolean> {
  const s = await getWorkerState();
  return !!s.claudePausedUntil && s.claudePausedUntil.getTime() > now.getTime();
}

/** The shortest pause: a reset time already past (or a clock skewed behind the database's) still pauses. */
const MIN_PAUSE_MS = 60_000;

/**
 * Pauses Claude until `until`, at least MIN_PAUSE_MS after `now`. A pause never shortens one already in force (two
 * workers, or an AUTH pause followed by a LIMITED one): the later end wins, with its reason.
 */
export async function pauseClaude(until: Date, reason: string, now: Date = new Date()): Promise<void> {
  await ensureRow();
  // As a timestamptz literal: a Date inside raw sql reaches the driver unserialized.
  const end = sql`${new Date(Math.max(until.getTime(), now.getTime() + MIN_PAUSE_MS)).toISOString()}::timestamptz`;
  const current = workerState.claudePausedUntil;
  await getDb()
    .update(workerState)
    .set({
      claudePausedUntil: sql`greatest(coalesce(${current}, ${end}), ${end})`,
      pauseReason: sql`case when ${current} is null or ${current} <= ${end} then ${reason} else ${workerState.pauseReason} end`,
    })
    .where(eq(workerState.singleton, true));
}

export async function clearClaudePause(): Promise<void> {
  await ensureRow();
  await getDb().update(workerState).set({ claudePausedUntil: null, pauseReason: null }).where(eq(workerState.singleton, true));
}

export async function heartbeat(): Promise<void> {
  await ensureRow();
  await getDb().update(workerState).set({ lastHeartbeatAt: new Date() }).where(eq(workerState.singleton, true));
}

export async function recordOkTurn(): Promise<void> {
  await ensureRow();
  await getDb().update(workerState).set({ lastOkTurnAt: new Date() }).where(eq(workerState.singleton, true));
}
