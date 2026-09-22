-- Email failure handling (founder instruction of 18 September 2026, item 5): bounces, complaints, suppression, retries.

CREATE TABLE IF NOT EXISTS email_suppressions (
  id uuid PRIMARY KEY,
  address text NOT NULL,
  reason text NOT NULL,
  source text NOT NULL DEFAULT 'postmark',
  active boolean NOT NULL DEFAULT true,
  count integer NOT NULL DEFAULT 1,
  first_at timestamptz NOT NULL DEFAULT now(),
  last_at timestamptz NOT NULL DEFAULT now(),
  provider_message_id text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  released_at timestamptz,
  released_by uuid,
  release_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS email_suppressions_address_idx ON email_suppressions (address, active);
--> statement-breakpoint
GRANT SELECT ON email_suppressions TO app_tenant;
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON email_suppressions FROM app_tenant;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS webhook_receipts (
  id uuid PRIMARY KEY,
  provider text NOT NULL,
  kind text NOT NULL,
  external_id text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  outcome text NOT NULL DEFAULT 'processed'
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS webhook_receipts_provider_external_idx ON webhook_receipts (provider, external_id);
--> statement-breakpoint
REVOKE ALL ON webhook_receipts FROM app_tenant;
--> statement-breakpoint
ALTER TABLE communications ADD COLUMN IF NOT EXISTS failure_type text;
--> statement-breakpoint
ALTER TABLE communications ADD COLUMN IF NOT EXISTS retry_of uuid;
--> statement-breakpoint
ALTER TABLE communications ADD COLUMN IF NOT EXISTS retry_attempt integer NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS communications_provider_message_idx ON communications (provider_message_id);
