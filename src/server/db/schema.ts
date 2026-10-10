import { sql } from "drizzle-orm";
import {
  pgTable, uuid, text, boolean, timestamp, jsonb, integer, doublePrecision, index, uniqueIndex,
} from "drizzle-orm/pg-core";
import type { Language, MessageKind, MessageOrigin, TurnStatus } from "../types";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const operators = pgTable("operators", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  isArham: boolean("is_arham").notNull().default(false),
  active: boolean("active").notNull().default(true),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const ambulances = pgTable(
  "ambulances",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    operatorId: uuid("operator_id").notNull().references(() => operators.id),
    label: text("label").notNull().unique(),
    city: text("city").notNull(),
    area: text("area"),
    state: text("state").notNull(),
    phone: text("phone").notNull(),
    phoneRaw: text("phone_raw"),
    areasCovered: text("areas_covered").array().notNull().default(sql`'{}'::text[]`),
    category: text("category").notNull().default("Animal Ambulance"),
    /** When the team answers, as the directory's Hours cell writes it ("10am–7pm IST"); null when none is published. */
    hours: text("hours"),
    active: boolean("active").notNull().default(true),
    updatedAt: ts("updated_at").notNull().defaultNow(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("ambulances_city_idx").on(t.city), index("ambulances_operator_idx").on(t.operatorId)]
);

export const clinics = pgTable("clinics", {
  id: uuid("id").primaryKey().defaultRandom(),
  operatorId: uuid("operator_id").notNull().references(() => operators.id),
  label: text("label").notNull().unique(),
  city: text("city").notNull(),
  area: text("area"),
  state: text("state").notNull(),
  phone: text("phone").notNull(),
  phoneRaw: text("phone_raw"),
  address: text("address"),
  hours: text("hours"),
  active: boolean("active").notNull().default(true),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    phone: text("phone").notNull().unique(),
    name: text("name"),
    language: text("language").$type<Language>(),
    mode: text("mode").$type<"agent" | "human">().notNull().default("agent"),
    flagged: boolean("flagged").notNull().default(false),
    flagReason: text("flag_reason"),
    welcomedAt: ts("welcomed_at"),
    lastInboundAt: ts("last_inbound_at"),
    lastOutboundAt: ts("last_outbound_at"),
    isTest: boolean("is_test").notNull().default(false),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("conversations_updated_idx").on(t.updatedAt),
    index("conversations_flagged_idx").on(t.flagged),
    index("conversations_is_test_idx").on(t.isTest),
  ]
);

export const turns = pgTable(
  "turns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
    status: text("status").$type<TurnStatus>().notNull(),
    model: text("model"),
    effort: text("effort"),
    structuredOutput: jsonb("structured_output"),
    toolCalls: jsonb("tool_calls"),
    handles: jsonb("handles"),
    usage: jsonb("usage"),
    latencyMs: integer("latency_ms"),
    sessionId: text("session_id"),
    error: text("error"),
    scrubbed: boolean("scrubbed").notNull().default(false),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("turns_conversation_idx").on(t.conversationId, t.createdAt)]
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
    role: text("role").$type<"user" | "assistant">().notNull(),
    origin: text("origin").$type<MessageOrigin>().notNull(),
    content: text("content").notNull().default(""),
    contentTemplate: text("content_template"),
    kind: text("kind").$type<MessageKind>().notNull().default("text"),
    mediaUrl: text("media_url"),
    transcript: text("transcript"),
    lat: doublePrecision("lat"),
    lng: doublePrecision("lng"),
    placeLabel: text("place_label"),
    providerMessageId: text("provider_message_id"),
    interactiveId: text("interactive_id"),
    /** sending (written before the Interakt call), sent, failed or test_skipped; null for reporter messages. */
    deliveryStatus: text("delivery_status"),
    /** Send attempts made for this reply: the first, then the resend sweep's (at most three in all). */
    deliveryAttempts: integer("delivery_attempts").notNull().default(1),
    /** Interakt's HTTP status for the latest attempt; 0 when no response came (network error, timeout). */
    deliveryHttpStatus: integer("delivery_http_status"),
    error: text("error"),
    answeredTurnId: uuid("answered_turn_id").references(() => turns.id, { onDelete: "set null" }),
    /** The turn that sent this assistant message; null for reporter messages and for replies sent outside a turn. */
    turnId: uuid("turn_id").references(() => turns.id, { onDelete: "set null" }),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("messages_conversation_idx").on(t.conversationId, t.createdAt),
    uniqueIndex("messages_provider_message_id_idx").on(t.providerMessageId),
    // Both reference turns with "on delete set null": deleting a turn must not scan every message.
    index("messages_turn_idx").on(t.turnId),
    index("messages_answered_turn_idx").on(t.answeredTurnId),
    // The resend sweep and the health check read recent messages across every conversation.
    index("messages_created_idx").on(t.createdAt),
    index("messages_pending_idx")
      .on(t.conversationId)
      .where(sql`${t.role} = 'user' and ${t.answeredTurnId} is null`),
  ]
);

export const events = pgTable(
  "events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id"),
    kind: text("kind").notNull(),
    payload: jsonb("payload"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("events_kind_idx").on(t.kind, t.createdAt)]
);

export const workerState = pgTable("worker_state", {
  singleton: boolean("singleton").primaryKey().default(true),
  claudePausedUntil: ts("claude_paused_until"),
  pauseReason: text("pause_reason"),
  lastHeartbeatAt: ts("last_heartbeat_at"),
  lastOkTurnAt: ts("last_ok_turn_at"),
  /** The latest send Interakt accepted (a first send or a resend): the health check's delivery signal. */
  lastDeliveredAt: ts("last_delivered_at"),
});

export type Operator = typeof operators.$inferSelect;
export type Ambulance = typeof ambulances.$inferSelect;
export type Clinic = typeof clinics.$inferSelect;
export type Conversation = typeof conversations.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
export type Turn = typeof turns.$inferSelect;
export type NewTurn = typeof turns.$inferInsert;
export type Event = typeof events.$inferSelect;
