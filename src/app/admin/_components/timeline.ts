import type { TurnRow } from "./turn-details";

export type Msg = {
  id: string; role: "user" | "assistant"; origin: string; kind: string; content: string; contentTemplate: string | null;
  deliveryStatus: string | null; error: string | null; turnId: string | null; createdAt: string; placeLabel: string | null;
  mediaUrl: string | null; lat: number | null; lng: number | null;
};

export type TimelineItem = { kind: "message"; message: Msg } | { kind: "turn"; turn: TurnRow };

const at = (item: TimelineItem) => Date.parse(item.kind === "message" ? item.message.createdAt : item.turn.createdAt);

/**
 * The transcript's rows by time: every message, and each turn that sent none of them but ended with an error, such as
 * the failed Claude turn behind a fallback reply. A turn still running has no error yet, so it is not shown as failed.
 */
export function buildTimeline(messages: Msg[], turns: TurnRow[]): TimelineItem[] {
  const senders = new Set(messages.map((m) => m.turnId));
  const items: TimelineItem[] = [
    ...messages.map((message) => ({ kind: "message" as const, message })),
    ...turns.filter((turn) => turn.error !== null && !senders.has(turn.id)).map((turn) => ({ kind: "turn" as const, turn })),
  ];
  return items.sort((a, b) => at(a) - at(b));
}
