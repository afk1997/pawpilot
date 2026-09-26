import { describe, it, expect } from "vitest";
import { buildTimeline, type Msg } from "@/app/admin/_components/timeline";
import type { TurnRow } from "@/app/admin/_components/turn-details";

const msg = (id: string, createdAt: string, turnId: string | null = null): Msg => ({
  id, role: turnId ? "assistant" : "user", origin: turnId ? "fallback" : "reporter", kind: "text", content: id, contentTemplate: null,
  deliveryStatus: null, error: null, turnId, createdAt, placeLabel: null, mediaUrl: null, lat: null, lng: null,
});
const turn = (id: string, createdAt: string, error: string | null): TurnRow => ({
  id, status: "failed", model: null, effort: null, structuredOutput: null, toolCalls: null, usage: null, latencyMs: null,
  sessionId: null, error, scrubbed: false, createdAt,
});
const labels = (items: ReturnType<typeof buildTimeline>) => items.map((i) => (i.kind === "message" ? i.message.id : `turn:${i.turn.id}`));

describe("buildTimeline", () => {
  it("places each turn no message came from, once it ended in an error, among the messages by time", () => {
    const items = buildTimeline(
      [msg("hi", "2026-09-26T10:00:00.000Z"), msg("card", "2026-09-26T10:00:41.000Z", "fallback"), msg("thanks", "2026-09-26T10:02:00.000Z")],
      [
        turn("claude", "2026-09-26T10:00:03.000Z", "timeout: no answer"), // the failed turn behind the fallback card
        turn("fallback", "2026-09-26T10:00:40.000Z", "timeout"), // sent the card: shown with it, not on its own
        turn("running", "2026-09-26T10:02:01.000Z", null), // no error yet, so not shown as a failure
      ]
    );
    expect(labels(items)).toEqual(["hi", "turn:claude", "card", "thanks"]);
  });

  it("keeps the messages alone when every turn sent one", () => {
    expect(labels(buildTimeline([msg("hi", "2026-09-26T10:00:00.000Z"), msg("reply", "2026-09-26T10:00:05.000Z", "t1")], [turn("t1", "2026-09-26T10:00:01.000Z", null)]))).toEqual(["hi", "reply"]);
  });
});
