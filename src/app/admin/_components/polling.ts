import { useEffect, useState } from "react";

/** A request with no answer by then is given up and counts as a failure, so a server that hangs shows as one. */
export const POLL_TIMEOUT_MS = 10_000;

export type PollState<T> = {
  /** The last good answer, kept through failures so the page can go on showing it under the banner. */
  data: T | null;
  /** When the last good answer came. */
  lastOkAt: Date | null;
  /** Why the latest poll failed and when; null again once one succeeds. */
  error: { reason: string; at: Date } | null;
  /** The latest answer was a 404. */
  notFound: boolean;
};

export const NOTHING_YET: PollState<never> = { data: null, lastOkAt: null, error: null, notFound: false };

/**
 * Fetches `url` now and every `intervalMs` after, one request at a time, and hands each change of state to `update`.
 * A 401 calls `onUnauthorized`. Any other failure (a non-OK answer, a network error, or no answer within
 * POLL_TIMEOUT_MS) sets `error` and keeps the last data; a 404 sets `notFound` as well. Returns `stop`, which aborts
 * the request in flight; nothing is handed over after it.
 */
export function startPolling<T>(
  url: string,
  intervalMs: number,
  update: (change: (state: PollState<T>) => PollState<T>) => void,
  onUnauthorized: () => void
): () => void {
  let stopped = false;
  let inFlight: AbortController | null = null;
  const poll = () => {
    if (inFlight) return;
    const controller = new AbortController();
    inFlight = controller;
    const timeout = setTimeout(() => controller.abort(new Error(`no answer in ${POLL_TIMEOUT_MS / 1000} s`)), POLL_TIMEOUT_MS);
    fetch(url, { cache: "no-store", signal: controller.signal })
      .then(async (res) => {
        if (stopped) return;
        if (res.status === 401) return onUnauthorized();
        if (!res.ok) {
          const error = { reason: `HTTP ${res.status}`, at: new Date() };
          return update((s) => ({ ...s, error, notFound: res.status === 404 }));
        }
        const data = (await res.json()) as T;
        if (!stopped) update(() => ({ data, lastOkAt: new Date(), error: null, notFound: false }));
      })
      .catch((err: unknown) => {
        if (!stopped) update((s) => ({ ...s, error: { reason: err instanceof Error ? err.message : String(err), at: new Date() } }));
      })
      .finally(() => {
        clearTimeout(timeout);
        inFlight = null;
      });
  };
  poll();
  const timer = setInterval(poll, intervalMs);
  return () => {
    stopped = true;
    clearInterval(timer);
    inFlight?.abort();
  };
}

/** `startPolling` for a component: restarts when `url` changes, dropping answers still due for the old one. */
export function usePolling<T>(url: string, intervalMs: number): PollState<T> {
  const [state, setState] = useState<PollState<T>>(NOTHING_YET);
  useEffect(() => startPolling<T>(url, intervalMs, setState, () => window.location.assign("/admin/login")), [url, intervalMs]);
  return state;
}
