import { and, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { getConfig } from "../config";
import { log, safeErrorFields } from "../log";
import { enqueueTurn, getBoss, stopBoss, TURN_QUEUE, type TurnJobData } from "../queue/boss";
import { setWebsiteUrl } from "../messages/welcome";
import { recordEvent } from "../inbound/store";
import { heartbeat } from "./pause";
import { flagConversation } from "./persist";
import { runTurn, type TurnOutcome } from "./turn-runner";
import { closeDb, getDb } from "../db/client";
import { conversations, events, messages } from "../db/schema";

/** With this many failed turns in the last hour, the sweep flags a conversation instead of re-running it. */
const SWEEP_FAILED_TURN_CAP = 3;

/**
 * Backstop for turns the queue never ran: a message that landed on a debounce-slot boundary, or an
 * enqueue that failed after the webhook stored the message. Enqueues an immediate turn for every
 * agent-mode conversation with a reporter message unanswered for over 15 s. So that a burst that keeps
 * failing is not retried forever, two cases are left alone:
 * - messages older than 6 h;
 * - conversations with SWEEP_FAILED_TURN_CAP or more `turn_failed` events in the last hour, which the
 *   sweep flags `turn_failed` (a reason already set wins), with a warning logged when it flags.
 * Nothing lists such messages: the dispatcher sees them only through the conversation's flag and the logs.
 * Returns how many jobs it created (enqueueTurn's null means one already exists).
 */
export async function sweepUnanswered(): Promise<number> {
  const recentFailures = sql<number>`(
    select count(*)::int from ${events}
    where ${events.conversationId} = ${messages.conversationId}
      and ${events.kind} = 'turn_failed'
      and ${events.createdAt} > now() - interval '1 hour'
  )`;
  const rows = await getDb()
    .selectDistinct({ conversationId: messages.conversationId, flagged: conversations.flagged, recentFailures })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(
      and(
        eq(messages.role, "user"),
        isNull(messages.answeredTurnId),
        lt(messages.createdAt, sql`now() - interval '15 seconds'`),
        gt(messages.createdAt, sql`now() - interval '6 hours'`),
        eq(conversations.mode, "agent")
      )
    );
  let enqueued = 0;
  for (const { conversationId, flagged, recentFailures: failures } of rows) {
    if (failures >= SWEEP_FAILED_TURN_CAP) {
      if (!flagged) {
        await flagConversation(conversationId, "turn_failed");
        log.warn({ conversationId }, "turns keep failing; sweep flagged the conversation instead of re-running it");
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
      // Longer than a Claude turn's 45 s default timeout, so an in-flight turn finishes instead of being failed.
      await stopBoss({ timeoutMs: 60_000 });
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
