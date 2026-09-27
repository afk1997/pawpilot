export const LANGUAGES = ["en", "hi", "mr", "gu"] as const;
export type Language = (typeof LANGUAGES)[number];

export type MessageKind =
  | "text" | "audio" | "image" | "video" | "document" | "location" | "sticker" | "contact" | "interactive";

export type MessageOrigin = "reporter" | "agent" | "fallback" | "human" | "system";

export const INTENTS = ["ambulance", "clinic", "donate", "volunteer", "faq", "suggestion", "smalltalk", "other"] as const;
export type Intent = (typeof INTENTS)[number];

export type TurnStatus = "ok" | "fallback" | "failed";
