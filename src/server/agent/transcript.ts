import type { Message } from "../db/schema";
import { menuChoiceLabel } from "../messages/welcome";

type Renderable = Pick<Message, "role" | "kind" | "content" | "contentTemplate" | "placeLabel" | "interactiveId" | "deliveryStatus" | "createdAt">;

const timeFmt = new Intl.DateTimeFormat("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" });

export function renderMessageForModel(m: Renderable): string {
  const time = timeFmt.format(m.createdAt);
  if (m.role === "assistant") {
    // A reply whose send failed never reached the reporter; the marker keeps the model from assuming it did.
    const undelivered = m.deliveryStatus === "failed" ? "[not delivered] " : "";
    return `[${time}] Assistant: ${undelivered}${m.contentTemplate ?? m.content}`;
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
  return `[${time}] Reporter: ${body}`;
}

export function renderTranscript(history: Message[], pending: Message[]): string {
  const pendingIds = new Set(pending.map((m) => m.id));
  const past = history.filter((m) => !pendingIds.has(m.id)).map(renderMessageForModel);
  const fresh = pending.map(renderMessageForModel);
  return `${past.join("\n")}\n\n--- NEW MESSAGES (answer these) ---\n${fresh.join("\n")}`.trim();
}
