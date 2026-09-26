import { and, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { getConfig } from "../config";
import { log, safeErrorFields } from "../log";
import { enqueueTurn, getBoss, stopBoss, TURN_QUEUE, type TurnJobData } from "../queue/boss";
import { setWebsiteUrl } from "../messages/welcome";
import { recordEvent } from "../inbound/store";
import { heartbeat } from "./pause";
import { flagConversation } from "./persist";
import { runTurn, type TurnOutcome } from "./turn-runner";
import { TURN_BUDGET_MS } from "./claude-turn";
import { SEND_TIMEOUT_MS } from "../interakt/client";
import { closeDb, getDb } from "../db/client";
import { conversations, events, messages } from "../db/schema";

/**
 * With this many `turn_failed` events in the last hour, the sweep flags a conversation for the dispatcher
 * instead of re-running it. Every failed attempt records one, so in practice a single job that exhausts its
 * three attempts trips the cap, some 15–30 s after its first failure with the queue's retry backoff when the
 * turns fail fast. New inbound messages still get fresh jobs from the webhook; only the sweep stops.
 */
const SWEEP_FAILED_TURN_CAP = 3;

/**
 * How long a stop waits for in-flight turns: a Claude turn's whole budget, its Interakt send and a margin for the
 * database work around them (145 s). pg-boss then fails what is still running and the job is retried on the next
 * worker, so a turn cut off between its send and its bookkeeping could reach the reporter twice. The container's
 * stop grace period must be longer than this (README, deploy notes).
 */
export const GRACEFUL_STOP_MS = TURN_BUDGET_MS + SEND_TIMEOUT_MS + 30_000;

/**
 * Backstop for turns the queue never ran: a message that landed on a debounce-slot boundary, or an
 * enqueue that failed after the webhook stored the message. Enqueues an immediate turn, longest-waiting
 * first, for every agent-mode conversation with a reporter message unanswered for over 15 s. So that a
 * burst that keeps failing is not retried forever, two cases are left alone:
 * - messages older than 6 h;
 * - conversations at SWEEP_FAILED_TURN_CAP, which the sweep flags `turn_failed` (a reason already set
 *   wins) with a warning when it flags; a failed flag write is logged and does not stop the sweep.
 * Nothing lists such messages: the dispatcher sees them only through the conversation's flag and the logs.
 * Returns how many jobs it created (enqueueTurn's null means one already exists).
 */
export async function sweepUnanswered(): Promise<number> {
  const db = getDb();
  // Counted once per conversation, then joined: a correlated count would run for every pending message.
  const recent = db
    .select({ conversationId: events.conversationId, failures: sql<number>`count(*)::int`.as("turn_failures_last_hour") })
    .from(events)
    .where(and(eq(events.kind, "turn_failed"), gt(events.createdAt, sql`now() - interval '1 hour'`)))
    .groupBy(events.conversationId)
    .as("recent_turn_failures");
  const rows = await db
    .select({
      conversationId: messages.conversationId,
      flagged: conversations.flagged,
      failures: sql<number>`coalesce(${recent.failures}, 0)`,
    })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .leftJoin(recent, eq(recent.conversationId, messages.conversationId))
    .where(
      and(
        eq(messages.role, "user"),
        isNull(messages.answeredTurnId),
        lt(messages.createdAt, sql`now() - interval '15 seconds'`),
        gt(messages.createdAt, sql`now() - interval '6 hours'`),
        eq(conversations.mode, "agent")
      )
    )
    .groupBy(messages.conversationId, conversations.flagged, recent.failures)
    .orderBy(sql`min(${messages.createdAt})`, messages.conversationId);
  let enqueued = 0;
  for (const { conversationId, flagged, failures } of rows) {
    if (failures >= SWEEP_FAILED_TURN_CAP) {
      if (!flagged) {
        try {
          await flagConversation(conversationId, "turn_failed");
          log.warn({ conversationId }, "turns keep failing; sweep flagged the conversation instead of re-running it");
        } catch {
          log.warn({ conversationId }, "turn_failed flag not recorded");
        }
      }
      continue;
    }
    if (await enqueueTurn(conversationId, { immediate: true })) enqueued += 1;
  }
  if (enqueued > 0) log.info({ enqueued }, "sweep enqueued turns");
  return enqueued;
}

export async function startWorker(opts: { concurrency?: number; heartbeatMs?: number; sweepMs?: number } = {}) {
  const cfg = getConfig();
  // index.ts loads the .env files only after log.ts has created the logger (imports are hoisted).
  log.level = cfg.logLevel;
  // Never more turns than WORKER_CONCURRENCY: the DB pool is sized from it, and each turn also opens a
  // connection of its own for its advisory lock.
  const concurrency = Math.min(opts.concurrency ?? cfg.workerConcurrency, cfg.workerConcurrency);
  setWebsiteUrl(cfg.websiteUrl);
  const boss = await getBoss("worker");

  await boss.work<TurnJobData>(
    TURN_QUEUE,
    { batchSize: 1, localConcurrency: concurrency, pollingIntervalSeconds: 1 },
    async ([job]) => {
      const { conversationId } = job.data;
      const started = Date.now();
      let outcome: TurnOutcome;
      try {
        outcome = await runTurn(conversationId);
      } catch (err) {
        const fields = safeErrorFields(err);
        log.error({ conversationId, ...fields }, "turn failed");
        // Counted by the sweep's attempt cap. Guarded: a failed insert must not replace the turn's own error.
        try {
          await recordEvent("turn_failed", fields, conversationId);
        } catch {
          log.warn({ conversationId }, "turn_failed event not recorded");
        }
        throw err; // pg-boss records the failure and retries the job
      }
      if (outcome.kind === "locked") log.warn({ conversationId }, "conversation lock busy; turn requeued");
      log.info({ conversationId, outcome: outcome.kind, ms: Date.now() - started }, "turn done");
    }
  );

  await heartbeat();
  const timer = setInterval(() => {
    heartbeat().catch((err) => log.warn(safeErrorFields(err), "heartbeat failed"));
  }, opts.heartbeatMs ?? 30_000);

  let sweeping: Promise<void> | null = null;
  const sweep = async () => {
    try {
      await sweepUnanswered();
    } catch (err) {
      log.warn(safeErrorFields(err), "sweep failed");
    }
  };
  const sweepTimer = setInterval(() => {
    if (sweeping) return; // the previous sweep is still running
    sweeping = sweep().finally(() => {
      sweeping = null;
    });
  }, opts.sweepMs ?? 60_000);

  log.info({ concurrency }, "worker started");
  return {
    async stop() {
      clearInterval(timer);
      clearInterval(sweepTimer);
      // A sweep still enqueueing after stopBoss would start a fresh pg-boss through getBoss().
      await sweeping;
      // Long enough for an in-flight turn to finish instead of being failed and retried (GRACEFUL_STOP_MS).
      await stopBoss({ timeoutMs: GRACEFUL_STOP_MS });
    },
  };
}

export async function runWorkerProcess(): Promise<void> {
  const worker = await startWorker();
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    // A Ctrl-C through npm or tsx reaches the worker twice (the terminal's signal plus the forwarded one).
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, "worker shutting down");
    let failed = false;
    try {
      await worker.stop();
    } catch (err) {
      failed = true;
      log.error(safeErrorFields(err), "worker stop failed");
    } finally {
      try {
        await closeDb();
      } catch (err) {
        failed = true;
        log.error(safeErrorFields(err), "database close failed");
      }
      log.info({ signal, failed }, "worker stopped");
      process.exit(failed ? 1 : 0);
    }
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}
