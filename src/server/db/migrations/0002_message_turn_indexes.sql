CREATE INDEX "messages_turn_idx" ON "messages" USING btree ("turn_id");--> statement-breakpoint
CREATE INDEX "messages_answered_turn_idx" ON "messages" USING btree ("answered_turn_id");