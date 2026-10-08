-- The one-time ITS check before a company goes public (founder decision B7; plan item B1). From this release a company
-- that signs itself up can draft and approve roles at once, but its careers page, job pages, Google listing and feeds
-- stay offline, and its messages to candidates wait in the outbox (status 'held'), until ITS confirms the company in the
-- admin console. The confirmation lives on companies.settings as verifiedAt (an ISO time) and verifiedBy (an actor);
-- the customer cannot set either.
--
-- Data only: settings is jsonb, so no column changes. Every company that exists before this migration was set up with
-- ITS (the founding-partner pilots, and the seed and test companies), so each is recorded as confirmed now and nothing
-- that is public today goes offline. A company that already carries a confirmation keeps it. Each backfill is recorded
-- as a company.verified event.
WITH confirmed AS (
  UPDATE companies
    SET settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object(
          'verifiedAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'verifiedBy', '{"kind":"system","id":"migration_0027","name":"Existing company, confirmed when the ITS check began"}'::jsonb
        ),
        updated_at = now()
    WHERE coalesce(settings->>'verifiedAt', '') = ''
    RETURNING id
)
INSERT INTO events (company_id, type, actor, subject_type, subject_id, payload)
  SELECT id, 'company.verified', '{"kind":"system","id":"migration_0027","name":"Existing company, confirmed when the ITS check began"}'::jsonb, 'company', id::text, jsonb_build_object('how', 'existing_company')
  FROM confirmed;
