-- Outbound messages are an outbox: a step or a route records the message inside its transaction as `queued`, and the
-- worker sends it after that transaction has committed. A transaction that rolls back therefore never leaves a sent
-- message behind, a retried step finds the row it already queued (the idempotency key is unique), and a message is
-- marked `sending` while the provider call is in flight so an interrupted send is visible rather than repeated.
ALTER TABLE communications ADD COLUMN IF NOT EXISTS idempotency_key text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS communications_idempotency_key_idx ON communications (idempotency_key) WHERE idempotency_key IS NOT NULL;
--> statement-breakpoint
ALTER TABLE communications ADD COLUMN IF NOT EXISTS sending_at timestamptz;
--> statement-breakpoint
ALTER TABLE communications ADD COLUMN IF NOT EXISTS send_attempts integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE communications ADD COLUMN IF NOT EXISTS reply_to text;
--> statement-breakpoint
ALTER TABLE communications ADD COLUMN IF NOT EXISTS tags jsonb NOT NULL DEFAULT '{}'::jsonb;
--> statement-breakpoint
ALTER TABLE communications ADD COLUMN IF NOT EXISTS attachments jsonb;
--> statement-breakpoint
ALTER TABLE communications ADD COLUMN IF NOT EXISTS correlation_id text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS communications_outbox_idx ON communications (status, created_at) WHERE direction = 'outbound' AND status IN ('queued', 'sending');
