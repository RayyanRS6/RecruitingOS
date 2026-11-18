-- One scoring system: the columns of a reading that nothing reads.
--
-- A reading (assessments) is the findings and the words the AI wrote, kept whole in assessments.result. Both scores are
-- worked out from those findings in code, each time they are shown: the resume score from a person's newest reading of
-- kind 'triage', the interview score from the scorecard their AI interview names (screens.assessment_id). So:
--
-- assessments.overall, assessments.confidence: a verdict word and a confidence the AI used to write, copied beside the
--   reading. Nothing reads either, and a reading no longer carries them.
-- assessments.secondary_score: never anything but NULL.
-- assessments.superseded_by: never written.
-- applications.latest_assessment_id: a pointer to "the latest reading" of either kind. The newest row of each kind is the
--   latest one.
--
-- assessments.packet_version stays: it is the job version a reading was made against. It differs from the application's
-- own once the job's must-haves or skills change and the person is read again.
--
-- No row is deleted and assessments.result is not touched. What the dropped columns held is not kept anywhere else: it
-- was a copy of two fields inside result (which older rows still hold there), nothing at all, or a pointer.
--
-- The release: the build before this one writes overall and confidence (both NOT NULL) with every reading it stores, so
-- its worker and its app are stopped before this migration runs, as for every migration that changes what a running
-- build relies on (docs/runbooks/production-setup.md, "The release").

-- allow-destructive: a copy of a verdict word nothing reads; the findings the scores are worked out from stay in assessments.result
ALTER TABLE assessments DROP COLUMN IF EXISTS overall;
--> statement-breakpoint
-- allow-destructive: a copy of a confidence nothing reads; the reading itself stays in assessments.result
ALTER TABLE assessments DROP COLUMN IF EXISTS confidence;
--> statement-breakpoint
-- allow-destructive: never held anything but NULL
ALTER TABLE assessments DROP COLUMN IF EXISTS secondary_score;
--> statement-breakpoint
-- allow-destructive: never written
ALTER TABLE assessments DROP COLUMN IF EXISTS superseded_by;
--> statement-breakpoint
-- allow-destructive: a pointer nothing reads; the newest reading of each kind is found by its own time
ALTER TABLE applications DROP COLUMN IF EXISTS latest_assessment_id;
