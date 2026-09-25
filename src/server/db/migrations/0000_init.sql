CREATE TABLE "ambulances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"label" text NOT NULL,
	"city" text NOT NULL,
	"area" text,
	"state" text NOT NULL,
	"phone" text NOT NULL,
	"phone_raw" text,
	"areas_covered" text[] DEFAULT '{}'::text[] NOT NULL,
	"category" text DEFAULT 'Animal Ambulance' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ambulances_label_unique" UNIQUE("label")
);
--> statement-breakpoint
CREATE TABLE "clinics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"label" text NOT NULL,
	"city" text NOT NULL,
	"area" text,
	"state" text NOT NULL,
	"phone" text NOT NULL,
	"phone_raw" text,
	"address" text,
	"hours" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clinics_label_unique" UNIQUE("label")
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone" text NOT NULL,
	"name" text,
	"language" text,
	"mode" text DEFAULT 'agent' NOT NULL,
	"flagged" boolean DEFAULT false NOT NULL,
	"flag_reason" text,
	"welcomed_at" timestamp with time zone,
	"last_inbound_at" timestamp with time zone,
	"last_outbound_at" timestamp with time zone,
	"is_test" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversations_phone_unique" UNIQUE("phone")
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid,
	"kind" text NOT NULL,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"role" text NOT NULL,
	"origin" text NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"content_template" text,
	"kind" text DEFAULT 'text' NOT NULL,
	"media_url" text,
	"transcript" text,
	"lat" double precision,
	"lng" double precision,
	"place_label" text,
	"provider_message_id" text,
	"interactive_id" text,
	"delivery_status" text,
	"error" text,
	"answered_turn_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operators" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"is_arham" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operators_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "turns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"status" text NOT NULL,
	"model" text,
	"effort" text,
	"structured_output" jsonb,
	"tool_calls" jsonb,
	"handles" jsonb,
	"usage" jsonb,
	"latency_ms" integer,
	"session_id" text,
	"error" text,
	"scrubbed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "worker_state" (
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"claude_paused_until" timestamp with time zone,
	"pause_reason" text,
	"last_heartbeat_at" timestamp with time zone,
	"last_ok_turn_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "ambulances" ADD CONSTRAINT "ambulances_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinics" ADD CONSTRAINT "clinics_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_answered_turn_id_turns_id_fk" FOREIGN KEY ("answered_turn_id") REFERENCES "public"."turns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turns" ADD CONSTRAINT "turns_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ambulances_city_idx" ON "ambulances" USING btree ("city");--> statement-breakpoint
CREATE INDEX "ambulances_operator_idx" ON "ambulances" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "conversations_updated_idx" ON "conversations" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "conversations_flagged_idx" ON "conversations" USING btree ("flagged");--> statement-breakpoint
CREATE INDEX "conversations_is_test_idx" ON "conversations" USING btree ("is_test");--> statement-breakpoint
CREATE INDEX "events_kind_idx" ON "events" USING btree ("kind","created_at");--> statement-breakpoint
CREATE INDEX "messages_conversation_idx" ON "messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_provider_message_id_idx" ON "messages" USING btree ("provider_message_id");--> statement-breakpoint
CREATE INDEX "messages_pending_idx" ON "messages" USING btree ("conversation_id") WHERE "messages"."role" = 'user' and "messages"."answered_turn_id" is null;--> statement-breakpoint
CREATE INDEX "turns_conversation_idx" ON "turns" USING btree ("conversation_id","created_at");