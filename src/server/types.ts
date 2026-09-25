// Internal types for the Arham Always Care WhatsApp agent.

export type Language = "en" | "hi" | "mr" | "gu";

export type ConversationStatus =
  | "new"
  | "awaiting_location"
  | "number_delivered"
  | "awaiting_followup"
  | "escalated"
  | "out_of_coverage"
  | "closed";

export type Intent = "emergency" | "donate" | "volunteer" | "clinic_info" | "faq" | "other";

export interface Conversation {
  id: string;
  phone: string;
  name: string | null;
  mode: "agent" | "human";
  status: ConversationStatus;
  intent: Intent | null;
  language: Language | null;
  delivered_ambulance_id: string | null;
  delivered_at: string | null;
  awaiting_followup_at: string | null;
  escalation_reason: string | null;
  claimed_by: string | null;
  claimed_at: string | null;
  last_inbound_at: string | null;
  updated_at: string;
  created_at: string;
}

export type MessageType =
  | "text"
  | "image"
  | "video"
  | "audio"
  | "document"
  | "location"
  | "sticker"
  | "contact"
  | "template";

export interface Message {
  id: string;
  conversation_id: string;
  role: "user" | "assistant";
  content: string;
  whatsapp_msg_id: string | null;
  message_type: MessageType;
  media_url: string | null;
  media_caption: string | null;
  location_lat: number | null;
  location_lng: number | null;
  is_instant_ack: boolean;
  is_template: boolean;
  template_name: string | null;
  delivery_status: "queued" | "sent" | "delivered" | "read" | "failed" | null;
  failed_reason: string | null;
  created_at: string;
}

export interface ConversationWithLastMessage extends Conversation {
  last_message: string | null;
}

export interface Ambulance {
  id: string;
  operator_id: string;
  label: string;
  city: string;
  area: string | null;
  state: string;
  phone: string;
  phone_raw: string | null;
  areas_covered: string[];
  category: string;
  active: boolean;
}

export interface NgoOperator {
  id: string;
  name: string;
  is_arham: boolean;
  ops_contact_name: string | null;
  ops_contact_phone: string | null;
  active: boolean;
}

export interface AmbulanceWithOperator extends Ambulance {
  operator: NgoOperator;
}

export interface Clinic {
  id: string;
  operator_id: string;
  label: string;
  city: string;
  area: string | null;
  state: string;
  phone: string;
  address: string | null;
  hours: string | null;
}

/**
 * Normalized inbound WhatsApp message — the shape the rest of the app sees,
 * regardless of whether the source is Interakt today or Meta tomorrow.
 */
export interface IncomingMessage {
  /** Provider's stable id for this message (used for idempotent dedup). */
  providerMessageId: string;
  /** Reporter phone in E.164 (+91XXXXXXXXXX). */
  fromPhone: string;
  /** Display name from WhatsApp profile, if available. */
  fromName: string | null;
  type: MessageType;
  /** Text body, or media caption, or empty. */
  text: string;
  /** Media URL if message_type is image/video/audio/document. */
  mediaUrl: string | null;
  /** Location lat/lng if message_type is location. */
  locationLat: number | null;
  locationLng: number | null;
  /** Provider's timestamp for the message. */
  receivedAt: Date;
}

export type AgentActionType =
  | "inbound"
  | "instant_ack"
  | "tool_call"
  | "outbound"
  | "escalation"
  | "dispatcher_takeover"
  | "dispatcher_release"
  | "dispatcher_send"
  | "status_change"
  | "followup_sent"
  | "closure_sent"
  | "degraded";
