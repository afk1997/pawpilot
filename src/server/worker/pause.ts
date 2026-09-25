import { eq } from "drizzle-orm";
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

export async function pauseClaude(until: Date, reason: string): Promise<void> {
  await ensureRow();
  await getDb().update(workerState).set({ claudePausedUntil: until, pauseReason: reason }).where(eq(workerState.singleton, true));
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
