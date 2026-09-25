import { and, eq, isNull, lt, sql } from "drizzle-orm";
import { getConfig } from "../config";
import { log } from "../log";
import { enqueueTurn, getBoss, stopBoss, TURN_QUEUE, type TurnJobData } from "../queue/boss";
import { setWebsiteUrl } from "../messages/welcome";
import { heartbeat } from "./pause";
import { runTurn } from "./turn-runner";
import { closeDb, getDb } from "../db/client";
import { conversations, messages } from "../db/schema";

/**
 * Backstop for turns the queue never ran: a message that landed on a debounce-slot
 * boundary, or an enqueue that failed after the webhook stored the message. Enqueues an
 * immediate turn for every agent-mode conversation with a reporter message unanswered for
 * over 15 s. Returns how many jobs it created (enqueueTurn's null means one already exists).
 */
export async function sweepUnanswered(): Promise<number> {
  const rows = await getDb()
    .selectDistinct({ conversationId: messages.conversationId })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(
      and(
        eq(messages.role, "user"),
        isNull(messages.answeredTurnId),
        lt(messages.createdAt, sql`now() - interval '15 seconds'`),
        eq(conversations.mode, "agent")
      )
    );
  let enqueued = 0;
  for (const { conversationId } of rows) {
    if (await enqueueTurn(conversationId, { immediate: true })) enqueued += 1;
  }
  if (enqueued > 0) log.info({ enqueued }, "sweep enqueued turns");
  return enqueued;
}

/** Code and class name only: a DB error's message, detail and params can quote reporter data. */
function errorKind(err: unknown): { code?: string; errorClass: string } {
  const e = (err ?? {}) as { code?: unknown; cause?: { code?: unknown } | null };
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  return { code: str(e.cause?.code) ?? str(e.code), errorClass: err instanceof Error ? err.constructor.name : typeof err };
}

export async function startWorker(opts: { concurrency?: number; heartbeatMs?: number; sweepMs?: number } = {}) {
  const cfg = getConfig();
  // index.ts loads the .env files only after log.ts has created the logger (imports are hoisted).
  log.level = cfg.logLevel;
  // The DB pool is sized from WORKER_CONCURRENCY; more turns than that can deadlock on their advisory locks.
  const concurrency = Math.min(opts.concurrency ?? cfg.workerConcurrency, cfg.workerConcurrency);
  setWebsiteUrl(cfg.websiteUrl);
  const boss = await getBoss("worker");

  await boss.work<TurnJobData>(
    TURN_QUEUE,
    { batchSize: 1, localConcurrency: concurrency, pollingIntervalSeconds: 1 },
    async ([job]) => {
      const started = Date.now();
      const outcome = await runTurn(job.data.conversationId);
      log.info({ conversationId: job.data.conversationId, outcome: outcome.kind, ms: Date.now() - started }, "turn done");
    }
  );

  await heartbeat();
  const timer = setInterval(() => {
    heartbeat().catch((err) => log.warn({ err }, "heartbeat failed"));
  }, opts.heartbeatMs ?? 30_000);

  let sweeping: Promise<void> | null = null;
  const sweep = async () => {
    try {
      await sweepUnanswered();
    } catch (err) {
      log.warn(errorKind(err), "sweep failed");
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
  const shutdown = async (signal: string) => {
    log.info({ signal }, "worker shutting down");
    await worker.stop();
    await closeDb();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}
