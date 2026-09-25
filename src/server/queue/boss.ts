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
 * (maintenance, expiration). Both create the queue idempotently.
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
    instance = boss;
    starting = null;
    return boss;
  })();
  return starting;
}

export async function stopBoss(): Promise<void> {
  if (starting) await starting.catch(() => undefined);
  if (instance) {
    await instance.stop({ graceful: true, timeout: 5000 });
    instance = null;
  }
}

/**
 * Debounced per conversation: a burst of messages produces one turn that
 * starts 2 s after the first. Returns null when pg-boss deduplicated it.
 */
export async function enqueueTurn(conversationId: string, opts: { immediate?: boolean } = {}): Promise<string | null> {
  const boss = await getBoss();
  return boss.send(
    TURN_QUEUE,
    { conversationId } satisfies TurnJobData,
    {
      singletonKey: conversationId,
      singletonSeconds: 3,
      startAfter: opts.immediate ? 0 : 2,
    }
  );
}
