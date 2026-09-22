ALTER TABLE "screens" ADD COLUMN "progress" jsonb DEFAULT '{"askedKeys":[],"currentQuestionKey":null,"followUps":{},"confusedTurns":0,"failures":0}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "screens" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "screens" ADD COLUMN "reminded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "screens" ADD COLUMN "human_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "screens" ADD COLUMN "last_candidate_message_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "screens_company_status_idx" ON "screens" USING btree ("company_id","status");