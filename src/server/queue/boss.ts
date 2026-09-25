import { PgBoss } from "pg-boss";
import { getConfig } from "../config";
import { log } from "../log";

export const TURN_QUEUE = "turn";

export interface TurnJobData {
  conversationId: string;
}

let instance: PgBoss | null = null;
let starting: Promise<PgBoss> | null = null;

/**
 * One pg-boss per process. The app only sends; the worker also supervises
 * (maintenance, expiration). Both create the queue idempotently. A failed
 * start is never memoized: the half-started instance is stopped and the next
 * call starts afresh.
 */
export function getBoss(role: "app" | "worker" = "app"): Promise<PgBoss> {
  if (instance) return Promise.resolve(instance);
  if (starting) return starting;
  starting = (async () => {
    const boss = new PgBoss({
      connectionString: getConfig().databaseUrl,
      schema: "pgboss",
      supervise: role === "worker",
      schedule: false,
      max: role === "worker" ? 4 : 2,
    });
    boss.on("error", (err) => log.error({ err }, "pg-boss error"));
    boss.on("warning", (warning) => log.warn({ warning }, "pg-boss warning"));
    try {
      await boss.start();
      const existing = await boss.getQueue(TURN_QUEUE);
      if (!existing) {
        await boss.createQueue(TURN_QUEUE, {
          policy: "singleton",
          retryLimit: 2,
          retryBackoff: true,
          retryDelay: 5,
          expireInSeconds: 120,
        });
      }
    } catch (err) {
      await boss.stop().catch(() => undefined);
      throw err;
    }
    instance = boss;
    return boss;
  })().finally(() => {
    starting = null;
  });
  return starting;
}

/** Graceful: jobs still running get `timeoutMs` (default 5 s) to finish before pg-boss fails them for a retry. */
export async function stopBoss(opts: { timeoutMs?: number } = {}): Promise<void> {
  if (starting) await starting.catch(() => undefined);
  if (instance) {
    await instance.stop({ graceful: true, timeout: opts.timeoutMs ?? 5000 });
    instance = null;
  }
}

/**
 * Debounced per conversation on 3 s slots. The first enqueue in a slot makes
 * a turn that starts 2 s later (now with `immediate`). While that slot is
 * taken, even by a turn that has already finished, the next enqueue goes into
 * the following slot; any more return null, because that deferred turn has
 * not started yet and will gather their messages.
 */
export async function enqueueTurn(conversationId: string, opts: { immediate?: boolean } = {}): Promise<string | null> {
  const boss = await getBoss();
  return boss.send(
    TURN_QUEUE,
    { conversationId } satisfies TurnJobData,
    {
      singletonKey: conversationId,
      singletonSeconds: 3,
      singletonNextSlot: true,
      startAfter: opts.immediate ? 0 : 2,
    }
  );
}
