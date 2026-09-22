-- Staff second factor (founder approval, 22 September 2026): remember when a person first verified an authenticator
-- with the identity service, so a later sign-in that finds no authenticator (a reset run in the service's dashboard)
-- is recognised and recorded rather than silently re-enrolled.
ALTER TABLE users ADD COLUMN mfa_enrolled_at timestamptz;
