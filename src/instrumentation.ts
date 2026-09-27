/**
 * Next.js calls register() once as a server starts. In the Node server it warms pg-boss in the background (warmBoss),
 * without awaiting it: a database that is slow to answer must not hold the server's start. Nothing runs in the edge
 * runtime, during `next build`, or outside Next (vitest never sets NEXT_RUNTIME).
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NEXT_PHASE === "phase-production-build") return;
  const { warmBoss } = await import("./server/queue/boss");
  warmBoss();
}
