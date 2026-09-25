export type Language = "en" | "hi" | "mr" | "gu";
export const LANGUAGES: Language[] = ["en", "hi", "mr", "gu"];

export type MessageKind =
  | "text" | "audio" | "image" | "video" | "document" | "location" | "sticker" | "contact" | "interactive";

export type MessageOrigin = "reporter" | "agent" | "fallback" | "human" | "system";

export type Intent =
  | "ambulance" | "clinic" | "donate" | "volunteer" | "faq" | "suggestion" | "smalltalk" | "other";

export type TurnStatus = "ok" | "fallback" | "failed";
