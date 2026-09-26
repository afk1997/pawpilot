import type { Message } from "../db/schema";
import { maskDigitRuns } from "./scrub";
import { menuChoiceLabel } from "../messages/welcome";

type Renderable = Pick<
  Message,
  "role" | "origin" | "kind" | "content" | "contentTemplate" | "placeLabel" | "interactiveId" | "deliveryStatus" | "createdAt"
>;

const IST = "Asia/Kolkata";
/** "10:03"; h23, so 00:15 IST never reads 24:15. */
const timeFmt = new Intl.DateTimeFormat("en-IN", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: IST });
/** The IST calendar day as parts; en-US keeps "Sep" on every ICU version, where en-IN writes "Sept". */
const dayFmt = new Intl.DateTimeFormat("en-US", { day: "numeric", month: "short", year: "numeric", timeZone: IST });

function istDay(d: Date): { day: string; month: string; year: string } {
  const parts = Object.fromEntries(dayFmt.formatToParts(d).map((p) => [p.type, p.value]));
  return { day: parts.day, month: parts.month, year: parts.year };
}

/** "10:03" on now's IST day, "24 Sep 10:03" on another day of the same year, "24 Sep 2025 10:03" in another year. */
function stampFor(at: Date, now: Date): string {
  const time = timeFmt.format(at);
  const a = istDay(at);
  const n = istDay(now);
  if (a.year !== n.year) return `${a.day} ${a.month} ${a.year} ${time}`;
  if (a.month !== n.month || a.day !== n.day) return `${a.day} ${a.month} ${time}`;
  return time;
}

/** Who sent an assistant-side row, as the model should read it. */
function assistantLabel(origin: Renderable["origin"]): string {
  switch (origin) {
    case "fallback": return "Assistant (automatic reply)";
    case "human": return "Helpline staff";
    case "system": return "System";
    default: return "Assistant";
  }
}

/**
 * The template when there is one (tokens, never digits). Without one, the sent text with every run the reply scrubber
 * would find masked (native numerals, any separator), so the model never sees digits it could copy, not even ones a
 * dispatcher typed. The welcome/menu list is named, not dumped.
 */
function assistantBody(m: Renderable): string {
  if (m.origin === "system" && m.kind === "interactive") return "[welcome/menu list sent]";
  return m.contentTemplate ?? maskDigitRuns(m.content, "[number sent]");
}

/** Any line break, including the Unicode separators a model may also read as one. */
const LINE_BREAK_RE = /\r\n|[\n\r\v\f\u0085\u2028\u2029]/g;

/** One transcript row. Continuation lines are indented, so no message text can pass for a row or a system line. */
function row(stamp: string, label: string, body: string): string {
  return `[${stamp}] ${label}: ${body.replace(LINE_BREAK_RE, "\n  ")}`;
}

export function renderMessageForModel(m: Renderable, now: Date = new Date()): string {
  const stamp = stampFor(m.createdAt, now);
  if (m.role === "assistant") {
    // A reply whose send failed never reached the reporter; the marker keeps the model from assuming it did.
    const undelivered = m.deliveryStatus === "failed" ? "[not delivered] " : "";
    return row(stamp, assistantLabel(m.origin), `${undelivered}${assistantBody(m)}`);
  }
  let body: string;
  switch (m.kind) {
    case "audio": body = "[voice note received — not transcribed]"; break;
    case "image": body = `[photo received]${m.content ? ` ${m.content}` : ""}`; break;
    case "video": body = `[video received]${m.content ? ` ${m.content}` : ""}`; break;
    case "document": body = `[document received]${m.content ? ` ${m.content}` : ""}`; break;
    case "sticker": body = "[sticker]"; break;
    case "contact": body = "[contact card received]"; break;
    case "location": body = m.placeLabel ? `[location pin: ${m.placeLabel}]` : "[location pin received]"; break;
    case "interactive": {
      const label = m.interactiveId ? menuChoiceLabel(m.interactiveId) : null;
      body = label ? `[menu choice: ${label}]` : m.content;
      break;
    }
    default: body = m.content;
  }
  return row(stamp, "Reporter", body);
}

export function renderTranscript(history: Message[], pending: Message[], now: Date = new Date()): string {
  const pendingIds = new Set(pending.map((m) => m.id));
  const render = (m: Message) => renderMessageForModel(m, now);
  const past = history.filter((m) => !pendingIds.has(m.id)).map(render);
  const fresh = pending.map(render);
  return `${past.join("\n")}\n\n--- NEW MESSAGES (answer these) ---\n${fresh.join("\n")}`.trim();
}
