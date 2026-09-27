ALTER TABLE "messages" ADD COLUMN "delivery_attempts" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "delivery_http_status" integer;--> statement-breakpoint
ALTER TABLE "worker_state" ADD COLUMN "last_delivered_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "messages_created_idx" ON "messages" USING btree ("created_at");