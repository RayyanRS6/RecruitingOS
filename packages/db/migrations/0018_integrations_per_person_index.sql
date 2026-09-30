-- Calendar connections are per person (migration 0008 added user_id and the per-person unique index), but the original
-- company-wide unique index on (company_id, provider) was never dropped. With it in place the second interviewer in a
-- company who connects Google Calendar hits a unique violation and the consent callback fails. The per-person index
-- (company_id, provider, kind, user_id) NULLS NOT DISTINCT from 0008 stays and is the only uniqueness rule from here on.
-- Not destructive: an index only; no data is touched.
DROP INDEX IF EXISTS integrations_company_provider_idx;
