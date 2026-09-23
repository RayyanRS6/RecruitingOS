-- Résumé storage (founder decision 2, 22 September 2026): every upload is quarantined until the worker has checked its
-- bytes and scanned it; only then does it move to its final key and become readable. Existing rows were parsed in the
-- request path before this change and are marked clean.
ALTER TABLE documents ADD COLUMN status text NOT NULL DEFAULT 'clean';
ALTER TABLE documents ADD COLUMN uploaded_via text NOT NULL DEFAULT 'server';
ALTER TABLE documents ADD COLUMN validated_at timestamptz;
ALTER TABLE documents ADD COLUMN scan_engine text;
ALTER TABLE documents ADD COLUMN scan_verdict text;
ALTER TABLE documents ADD COLUMN rejected_reason text;
CREATE INDEX documents_company_status_idx ON documents (company_id, status);
