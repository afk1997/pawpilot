import { describe, it, expect } from "vitest";
import { coordinates, flagBadge, flagLabel, formatWhen, mapsUrl, staleMessage } from "@/app/admin/_components/format";

const local = (year: number, month: number, day: number, hour: number, minute: number) => new Date(year, month - 1, day, hour, minute);
const time = (d: Date) => d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });

describe("formatWhen", () => {
  const at = local(2026, 9, 26, 10, 5);

  it("shows the time alone on the same day", () => {
    expect(formatWhen(at, local(2026, 9, 26, 23, 59))).toBe(time(at));
    expect(formatWhen(at.toISOString(), local(2026, 9, 26, 0, 1))).toBe(time(at));
  });

  it("puts the date in front on another day, with the year when that differs too", () => {
    expect(formatWhen(at, local(2026, 9, 27, 0, 1))).toBe(`${at.toLocaleDateString("en-IN", { day: "numeric", month: "short" })}, ${time(at)}`);
    const otherYear = `${at.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}, ${time(at)}`;
    expect(formatWhen(at, local(2027, 1, 2, 9, 0))).toBe(otherYear);
    expect(formatWhen(at, null)).toBe(otherYear);
  });
});

describe("flag labels", () => {
  it("names each reason the worker sets in words", () => {
    expect(["send_failed", "needs_human", "claude_unavailable", "turn_failed"].map((r) => flagLabel(r))).toEqual([
      "send failed",
      "needs human",
      "Claude unavailable",
      "turn failed",
    ]);
    expect(flagLabel("dispatcher_note")).toBe("dispatcher note");
    expect(flagLabel("constructor")).toBe("constructor");
    expect(flagLabel(null)).toBe("flagged");
  });

  it("leaves the flag badge out when the send-failed badge already says it", () => {
    expect(flagBadge({ flagged: true, flagReason: "send_failed", lastDeliveryStatus: "failed" })).toBeNull();
    expect(flagBadge({ flagged: true, flagReason: "send_failed", lastDeliveryStatus: "sent" })).toBe("send failed");
    expect(flagBadge({ flagged: true, flagReason: "needs_human", lastDeliveryStatus: "failed" })).toBe("needs human");
    expect(flagBadge({ flagged: true, flagReason: null, lastDeliveryStatus: null })).toBe("flagged");
    expect(flagBadge({ flagged: false, flagReason: "needs_human", lastDeliveryStatus: null })).toBeNull();
  });
});

describe("staleMessage", () => {
  it("says since when the page shows old data", () => {
    const ok = local(2026, 9, 26, 9, 41);
    expect(staleMessage(ok, local(2026, 9, 26, 9, 45))).toBe(`Can't reach the server — last updated ${time(ok)}`);
    expect(staleMessage(ok, local(2026, 9, 27, 0, 2))).toBe(`Can't reach the server — last updated ${formatWhen(ok, local(2026, 9, 27, 0, 2))}`);
    expect(staleMessage(null, local(2026, 9, 26, 9, 45))).toBe("Can't reach the server — nothing loaded yet");
  });
});

describe("location pins", () => {
  it("shows the coordinates and links them to the map", () => {
    expect(coordinates(19.0759837, 72.8776559)).toBe("19.07598, 72.87766");
    expect(mapsUrl(19.0759837, 72.8776559)).toBe("https://www.google.com/maps/search/?api=1&query=19.0759837,72.8776559");
  });
});
