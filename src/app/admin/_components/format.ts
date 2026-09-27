const LOCALE = "en-IN";
const TIME: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit" };
const DAY: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" };
const DAY_AND_YEAR: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "numeric" };

/**
 * A time as the admin page shows it: alone when it falls on the same day as `now`, after its date otherwise, with the
 * year when that differs too. Without a `now` the date and year are always shown.
 */
export function formatWhen(value: string | Date, now: Date | null): string {
  const d = new Date(value);
  const time = d.toLocaleTimeString(LOCALE, TIME);
  if (now && d.toDateString() === now.toDateString()) return time;
  const day = d.toLocaleDateString(LOCALE, now && d.getFullYear() === now.getFullYear() ? DAY : DAY_AND_YEAR);
  return `${day}, ${time}`;
}

/** The reasons the worker flags a conversation with, in words. */
const FLAG_LABELS = new Map([
  ["send_failed", "send failed"],
  ["needs_human", "needs human"],
  ["claude_unavailable", "Claude unavailable"],
  ["turn_failed", "turn failed"],
]);

/** A flag reason in words; one not listed reads with its underscores as spaces, and no reason reads "flagged". */
export function flagLabel(reason: string | null): string {
  if (!reason) return "flagged";
  return FLAG_LABELS.get(reason) ?? reason.replaceAll("_", " ");
}

/** A list row's flag badge: null when the row is not flagged, or when the flag only repeats its "send failed" badge. */
export function flagBadge(row: { flagged: boolean; flagReason: string | null; lastDeliveryStatus: string | null }): string | null {
  if (!row.flagged || (row.flagReason === "send_failed" && row.lastDeliveryStatus === "failed")) return null;
  return flagLabel(row.flagReason);
}

/** The banner while polls fail: since when the page has shown old data, the time read from the day of the failure. */
export function staleMessage(lastOkAt: Date | null, failedAt: Date): string {
  return lastOkAt ? `Can't reach the server — last updated ${formatWhen(lastOkAt, failedAt)}` : "Can't reach the server — nothing loaded yet";
}

/** A pin's position to five decimals, about a metre. */
export function coordinates(lat: number, lng: number): string {
  return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}

export function mapsUrl(lat: number, lng: number): string {
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
}
