import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NOTHING_YET, POLL_TIMEOUT_MS, startPolling, type PollState } from "@/app/admin/_components/polling";

const ok = (data: unknown) => ({ ok: true, status: 200, json: async () => data }) as unknown as Response;
const status = (code: number) => ({ ok: false, status: code, json: async () => ({ error: "x" }) }) as unknown as Response;
type Answer = Response | Error | "hang";

/** Stubs fetch with one answer per request, in order; "hang" never answers unless its request is aborted. */
function serve(...answers: Answer[]): string[] {
  const urls: string[] = [];
  vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
    urls.push(url);
    const next = answers.shift() ?? new Error("no answer queued");
    if (next === "hang") return new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  });
  return urls;
}

function poller(intervalMs = 1000) {
  const seen = { state: NOTHING_YET as PollState<unknown>, unauthorized: 0 };
  const stop = startPolling<unknown>("/api/x", intervalMs, (change) => { seen.state = change(seen.state); }, () => { seen.unauthorized += 1; });
  return { seen, stop };
}

const T0 = new Date(2026, 8, 26, 10, 0, 0);
const after = (ms: number) => new Date(T0.getTime() + ms);

describe("startPolling", () => {
  beforeEach(() => vi.useFakeTimers({ now: T0 }));
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("keeps the last good answer through failures and says when it came and when polls failed", async () => {
    serve(ok([1]), status(503), new TypeError("Failed to fetch"), ok([2]));
    const { seen, stop } = poller();
    await vi.advanceTimersByTimeAsync(0);
    expect(seen.state).toEqual({ data: [1], lastOkAt: T0, error: null, notFound: false });
    await vi.advanceTimersByTimeAsync(1000);
    expect(seen.state).toEqual({ data: [1], lastOkAt: T0, error: { reason: "HTTP 503", at: after(1000) }, notFound: false });
    await vi.advanceTimersByTimeAsync(1000);
    expect(seen.state).toEqual({ data: [1], lastOkAt: T0, error: { reason: "Failed to fetch", at: after(2000) }, notFound: false });
    await vi.advanceTimersByTimeAsync(1000);
    expect(seen.state).toEqual({ data: [2], lastOkAt: after(3000), error: null, notFound: false });
    stop();
  });

  it("reports a first failure with no data yet, a 404 as a failure that also means not found, and a 401 to the caller", async () => {
    serve(new TypeError("Failed to fetch"), status(404), status(401));
    const { seen, stop } = poller();
    await vi.advanceTimersByTimeAsync(0);
    expect(seen.state).toEqual({ data: null, lastOkAt: null, error: { reason: "Failed to fetch", at: T0 }, notFound: false });
    await vi.advanceTimersByTimeAsync(1000);
    expect(seen.state).toEqual({ data: null, lastOkAt: null, error: { reason: "HTTP 404", at: after(1000) }, notFound: true });
    await vi.advanceTimersByTimeAsync(1000);
    expect(seen.unauthorized).toBe(1);
    stop();
  });

  it("sends one request at a time and counts one with no answer in time as a failure", async () => {
    const urls = serve("hang", ok([1]));
    const { seen, stop } = poller(3000);
    await vi.advanceTimersByTimeAsync(POLL_TIMEOUT_MS - 1);
    expect(urls).toHaveLength(1); // the ticks at 3, 6 and 9 s found the first request still waiting
    expect(seen.state.error).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(seen.state.error).toEqual({ reason: `no answer in ${POLL_TIMEOUT_MS / 1000} s`, at: after(POLL_TIMEOUT_MS) });
    await vi.advanceTimersByTimeAsync(2000);
    expect(urls).toHaveLength(2);
    expect(seen.state).toMatchObject({ data: [1], error: null });
    stop();
  });

  it("aborts the request in flight on stop and drops whatever it answers after", async () => {
    // A late answer must not update a page that is gone, nor send it to the login page.
    for (const late of [ok([1]), status(503), status(401), "rejected on abort"] as const) {
      let signal: AbortSignal | undefined;
      let answer!: (res: Response) => void;
      vi.stubGlobal("fetch", (_url: string, init: RequestInit) => {
        signal = init.signal ?? undefined;
        return new Promise<Response>((resolve, reject) => {
          answer = resolve;
          if (late === "rejected on abort") signal?.addEventListener("abort", () => reject(signal?.reason));
        });
      });
      const { seen, stop } = poller();
      stop();
      expect(signal?.aborted).toBe(true);
      if (late !== "rejected on abort") answer(late);
      await vi.advanceTimersByTimeAsync(5000);
      expect(seen).toEqual({ state: NOTHING_YET, unauthorized: 0 });
    }
  });
});
