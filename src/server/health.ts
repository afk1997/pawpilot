import { and, desc, eq, gt, gte, inArray, lt } from "drizzle-orm";
import { getConfig } from "./config";
import { getDb, getSql } from "./db/client";
import { conversations, events, messages } from "./db/schema";
import { getWorkerState } from "./worker/pause";
import { TURN_QUEUE } from "./queue/boss";
import { log, safeErrorFields } from "./log";

const HEARTBEAT_MAX_S = 120;
/** This many of the latest finished sends, all failed and all within FAILED_SENDS_WINDOW_MS, is a delivery outage. */
const FAILED_SENDS = 5;
const FAILED_SENDS_WINDOW_MS = 15 * 60_000;
/** A reporter message that has waited this long with nothing delivered since it came is a delivery outage. */
const WAITING_MAX_MS = 10 * 60_000;
/** Reporter messages older than this are not read for that check (last_delivered_at is null on an older database). */
const WAITING_LOOKBACK_MS = 60 * 60_000;

/** `failed`: turn jobs that exhausted their retries and that pg-boss still retains. */
type QueueCounts = { queued: number; active: number; failed: number };

/**
 * Read from pg-boss's own table, not getQueue: the counts getQueue reports are refreshed only by a supervising
 * instance, and the app's never supervises. Null while pg-boss has not created its schema yet (a fresh database
 * before the worker's first start).
 */
async function turnQueueCounts(): Promise<QueueCounts | null> {
  const [{ present }] = await getSql()<{ present: boolean }[]>`select to_regclass('pgboss.job') is not null as present`;
  if (!present) return null;
  const rows = await getSql()<{ state: string; n: number }[]>`
    select state, count(*)::int as n from pgboss.job
    where name = ${TURN_QUEUE} and state in ('created', 'retry', 'active', 'failed')
    group by state`;
  const count = (state: string) => rows.find((r) => r.state === state)?.n ?? 0;
  return { queued: count("created") + count("retry"), active: count("active"), failed: count("failed") };
}

/**
 * "degraded" when replies are not getting out: the latest FAILED_SENDS finished sends to real conversations all
 * failed within FAILED_SENDS_WINDOW_MS, or a reporter message in an agent-mode conversation has waited over
 * WAITING_MAX_MS with nothing delivered since it came (so a first message after a quiet spell is not an outage).
 */
async function deliveryCheck(now: Date, lastDeliveredAt: Date | null): Promise<"ok" | "degraded"> {
  const db = getDb();
  const latest = await db
    .select({ status: messages.deliveryStatus, createdAt: messages.createdAt })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(and(eq(messages.role, "assistant"), eq(conversations.isTest, false), inArray(messages.deliveryStatus, ["sent", "failed"])))
    .orderBy(desc(messages.createdAt))
    .limit(FAILED_SENDS);
  const windowStart = now.getTime() - FAILED_SENDS_WINDOW_MS;
  if (latest.length === FAILED_SENDS && latest.every((m) => m.status === "failed" && m.createdAt.getTime() >= windowStart)) return "degraded";
  const since = new Date(Math.max(lastDeliveredAt?.getTime() ?? 0, now.getTime() - WAITING_LOOKBACK_MS));
  const waiting = await db
    .select({ id: messages.id })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(
      and(
        eq(messages.role, "user"),
        eq(conversations.isTest, false),
        eq(conversations.mode, "agent"),
        gt(messages.createdAt, since),
        lt(messages.createdAt, new Date(now.getTime() - WAITING_MAX_MS))
      )
    )
    .limit(1);
  return waiting.length > 0 ? "degraded" : "ok";
}

export async function computeHealth(now: Date = new Date()) {
  const checks = {
    db: false,
    workerHeartbeatAgeS: null as number | null,
    lastOkTurnAgeS: null as number | null,
    lastDeliveredAgeS: null as number | null,
    /** Null when the database could not be read. */
    delivery: null as "ok" | "degraded" | null,
    claudePaused: false,
    claudePausedUntil: null as string | null,
    pauseReason: null as string | null,
    authErrorLastHour: false,
    tokenDaysLeft: null as number | null,
    queue: null as QueueCounts | null,
  };
  try {
    await getSql()`select 1`;
    checks.db = true;
    const s = await getWorkerState();
    checks.workerHeartbeatAgeS = s.lastHeartbeatAt ? Math.round((now.getTime() - s.lastHeartbeatAt.getTime()) / 1000) : null;
    checks.lastOkTurnAgeS = s.lastOkTurnAt ? Math.round((now.getTime() - s.lastOkTurnAt.getTime()) / 1000) : null;
    checks.lastDeliveredAgeS = s.lastDeliveredAt ? Math.round((now.getTime() - s.lastDeliveredAt.getTime()) / 1000) : null;
    checks.claudePausedUntil = s.claudePausedUntil && s.claudePausedUntil > now ? s.claudePausedUntil.toISOString() : null;
    checks.claudePaused = checks.claudePausedUntil !== null;
    checks.pauseReason = checks.claudePausedUntil ? s.pauseReason : null;
    const hourAgo = new Date(now.getTime() - 3_600_000);
    const auth = await getDb().select({ id: events.id }).from(events).where(and(eq(events.kind, "claude_auth_error"), gte(events.createdAt, hourAgo))).limit(1);
    checks.authErrorLastHour = auth.length > 0;
    checks.delivery = await deliveryCheck(now, s.lastDeliveredAt);
    try {
      checks.queue = await turnQueueCounts();
    } catch (err) {
      log.warn({ ...safeErrorFields(err) }, "health: queue check failed");
    }
  } catch (err) {
    log.error({ ...safeErrorFields(err) }, "health: db check failed");
  }
  const issued = getConfig().claude.tokenIssuedAt;
  if (issued) {
    const issuedAt = new Date(issued);
    if (!isNaN(issuedAt.getTime())) checks.tokenDaysLeft = Math.floor((issuedAt.getTime() + 365 * 86_400_000 - now.getTime()) / 86_400_000);
  }
  const ok =
    checks.db &&
    checks.workerHeartbeatAgeS !== null &&
    checks.workerHeartbeatAgeS <= HEARTBEAT_MAX_S &&
    !checks.authErrorLastHour &&
    checks.delivery !== "degraded";
  return { ok, status: ok ? (200 as const) : (503 as const), checks };
}
