import { and, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "../db/client";
import { conversations, messages, type Conversation, type Message } from "../db/schema";
import { isGreetingOnly, isMenuWord } from "../lang";
import { MENU_BUTTON_LABEL, MENU_SECTION_TITLE, menuRows, menuText, welcomeText } from "../messages/welcome";
import { deliverList } from "./deliver";
import type { Language } from "../types";

/** Atomic first-contact claim: true for exactly one caller per conversation. */
export async function claimWelcome(conversationId: string): Promise<boolean> {
  const rows = await getDb()
    .update(conversations)
    .set({ welcomedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(conversations.id, conversationId), isNull(conversations.welcomedAt)))
    .returning({ id: conversations.id });
  return rows.length === 1;
}

/**
 * Whether no reply has been written in the conversation yet, sent or not (no assistant message, whatever its delivery
 * status): its first contact, whose answer opens with a greeting. A turn that failed before its reply was written left
 * no message, so its retry still reads true, where the welcome claim, already taken, would not.
 */
export async function isFirstContact(conversationId: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.role, "assistant")))
    .limit(1);
  return row === undefined;
}

/** `turnId`: the system turn that sends it, stored on the message; `answers`: the messages it answers (deliverList). */
export async function sendWelcome(conversation: Conversation, lang: Language, turnId: string | null = null, answers: string[] = []): Promise<Message> {
  const r = await deliverList(conversation, {
    list: { body: welcomeText(lang), buttonLabel: MENU_BUTTON_LABEL[lang], sectionTitle: MENU_SECTION_TITLE[lang], rows: menuRows(lang) },
    fallbackText: welcomeText(lang),
    origin: "system",
    turnId,
    answers,
  });
  return r.message;
}

/** `turnId`: the system turn that sends it, stored on the message; `answers`: the messages it answers (deliverList). */
export async function sendMenu(conversation: Conversation, lang: Language, turnId: string | null = null, answers: string[] = []): Promise<Message> {
  const r = await deliverList(conversation, {
    list: { body: menuText(lang), buttonLabel: MENU_BUTTON_LABEL[lang], sectionTitle: MENU_SECTION_TITLE[lang], rows: menuRows(lang) },
    fallbackText: menuText(lang),
    origin: "system",
    turnId,
    answers,
  });
  return r.message;
}

/** Classifies a burst so the runner can short-circuit without Claude. */
export function classifyPending(pending: Message[]): { allGreeting: boolean; allMenu: boolean; allAudio: boolean } {
  const isMenuTap = (m: Message) => m.kind === "interactive" && !!m.interactiveId?.startsWith("menu:");
  const isTrivial = (m: Message) =>
    m.kind === "sticker" || (m.kind === "interactive" && !isMenuTap(m) && isGreetingOnly(m.content)) || (m.kind === "text" && isGreetingOnly(m.content));
  return {
    allGreeting: pending.length > 0 && pending.every(isTrivial),
    allMenu: pending.length > 0 && pending.every((m) => m.kind === "text" && isMenuWord(m.content)),
    allAudio: pending.length > 0 && pending.every((m) => m.kind === "audio"),
  };
}
