import { sql } from "drizzle-orm";
import { getDb } from "../db/client";
import { conversations, events, messages, type Conversation } from "../db/schema";
import type { MessageKind } from "../types";

/** Postgres `text` rejects U+0000 (SQLSTATE 22021), so a payload carrying one would fail on every retry. */
export function stripNul(value: string): string {
  return value.replaceAll("\u0000", "");
}

export function stripNulOrNull(value: string | null | undefined): string | null {
  return value == null ? null : stripNul(value);
}

export async function upsertConversationByPhone(input: { phone: string; name: string | null }): Promise<Conversation> {
  const now = new Date();
  const [row] = await getDb()
    .insert(conversations)
    .values({ phone: input.phone, name: stripNulOrNull(input.name), lastInboundAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: conversations.phone,
      set: {
        name: sql`coalesce(${conversations.name}, excluded.name)`,
        lastInboundAt: now,
        updatedAt: now,
      },
    })
    .returning();
  return row;
}

export interface ReporterMessageInput {
  providerMessageId?: string | null;
  kind: MessageKind;
  content: string;
  mediaUrl?: string | null;
  lat?: number | null;
  lng?: number | null;
  placeLabel?: string | null;
  interactiveId?: string | null;
}

/** Inserts a reporter message; `inserted: false` when the provider id already exists. */
export async function storeReporterMessage(
  conversationId: string,
  m: ReporterMessageInput
): Promise<{ inserted: boolean; id: string | null }> {
  const rows = await getDb()
    .insert(messages)
    .values({
      conversationId,
      role: "user",
      origin: "reporter",
      kind: m.kind,
      content: stripNul(m.content ?? ""),
      mediaUrl: stripNulOrNull(m.mediaUrl),
      lat: m.lat ?? null,
      lng: m.lng ?? null,
      placeLabel: stripNulOrNull(m.placeLabel),
      providerMessageId: stripNulOrNull(m.providerMessageId),
      interactiveId: stripNulOrNull(m.interactiveId),
    })
    .onConflictDoNothing({ target: messages.providerMessageId })
    .returning({ id: messages.id });
  if (rows.length === 0) return { inserted: false, id: null };
  return { inserted: true, id: rows[0].id };
}

export async function recordEvent(kind: string, payload: unknown, conversationId: string | null = null): Promise<void> {
  await getDb().insert(events).values({ kind, payload: payload as object, conversationId });
}
