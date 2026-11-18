# Resume storage: a private bucket, direct uploads, quarantine, audited reads

## How it works

1. **Upload.** On the application form a small script (served under the page's nonce) asks the app for an upload authorization (`POST /careers/:slug/jobs/:roleId/upload-intent` with the file's name, size and type), sends the file straight to storage with a presigned single-object PUT that lives five minutes and is pinned to one content type, and sends the form with a sealed grant instead of the file. Without script, or when the direct upload fails, the form posts the file itself through the app; the hosting platform caps those bodies at 4.5 MB, so a file over 4 MB needs the direct path. A grant attaches its file to one application. Sent again it is refused like an expired one, before the file is looked at. A file nobody sends is removed a day later by a queued job.
2. **Quarantine.** Every file first lives under `quarantine/<company>/<job>/<random>.<ext>` with its document row in status `quarantined`. Nobody can open it: the team's download route answers 409 for anything not `clean`.
3. **Check and scan (the worker).** The application workflow's `validate` step (`packages/workflows/src/documents.ts`) reads the bytes, judges them by signature and structure (`packages/contracts/src/security/file-inspection.ts`: PDF, .docx or plain text only, 8 MB at most; programs, encrypted or macro-bearing documents, archives, malformed or empty files are refused, and so is a declared type that contradicts the bytes), then asks the scanner. A scanner outage leaves the file in quarantine and the step retries. A refused file is removed at once and the reason recorded. The application stays, and the team reads "This file was refused or removed and cannot be opened." and "Resume could not be read".
4. **Promote.** A clean file moves to `<company>/<candidate>/<application>/<random>.<ext>` (never the person's file name), the quarantine copy is deleted, and its text is extracted. Only then is the resume read by AI.
5. **Read.** Someone on the team who may read the application opens the file through `GET /api/v1/applications/:id/documents/:documentId/file`, which records `document.read` (who, which file) and redirects to a presigned GET that lives two minutes. The candidate panel frames it through `…/inline`. No bucket is public, no permanent file address exists, and storage keys are never sent to the browser.
6. **Delete.** A fulfilled deletion request removes the object, marks the row `deleted` and records `document.deleted`.

Company logos live in the same bucket.

## The bucket

The app talks to Supabase Storage over its S3-compatible endpoint with the project's **S3 access keys**: a storage-only credential that cannot reach the database or sign-in, and never the service-role key. The keys are not scoped to a bucket at the provider, so the project holds exactly one bucket for this app.

1. Supabase, the production project, **Storage**, **New bucket**: name `resumes`, **Private**, file size limit `8 MB`, allowed MIME types `application/pdf`, `application/vnd.openxmlformats-officedocument.wordprocessingml.document`, `text/plain`, `text/markdown`, and the logo types `image/png`, `image/jpeg`, `image/webp`. A bucket that refuses a type answers the write with an error and the file is not kept.
2. **Storage**, **Settings**: global file size limit at least 8 MB.
3. **Storage**, **S3 Configuration**: enable the S3 protocol; note the endpoint and region shown there.
4. **Access keys**, **New access key**, twice: one pair for the app (Vercel) and one for the worker (Railway). Each goes into the password vault, never into chat.
5. The variables (`STORAGE_PROVIDER`, `STORAGE_BUCKET`, the `STORAGE_S3_*` values) are in [14-deployment-and-environment.md](../14-deployment-and-environment.md). The adapter refuses to start if one is missing, and names it.

**Rotate a key.** **S3 Configuration**, **Access keys**: create a new pair, enter it on the side that holds the old one, redeploy, then delete the old pair. A presigned address already issued dies with its key.

## Running ClamAV on Railway

The scanner speaks clamd's own TCP protocol, so the engine is the official image and nothing else: no file leaves Railway's private network. The worker is the only process that scans; the app keeps `SCAN_PROVIDER=fake` because it never opens a quarantined file.

1. Railway, the production project, **New**, **Docker Image**, image `clamav/clamav:stable`. Name the service `clamav`.
2. Service **Settings**: no public networking; **Private Networking** on, so the worker reaches it as `clamav.railway.internal`. The image listens on port `3310` and refreshes its signatures itself. It needs about 1.5 GB of memory once the signatures are loaded. Optional variables on the `clamav` service: `CLAMAV_NO_MILTER=true` and `CLAMD_STARTUP_TIMEOUT=1800` (the first start downloads the signatures).
3. The worker's **Variables**: `SCAN_PROVIDER=clamav`, `CLAMAV_HOST=clamav.railway.internal`. Redeploy the worker.
4. Check the worker's log: no `[scanner] clamav did not answer the boot check` line. That line means the host or port is wrong, or clamd is still loading signatures; the worker runs anyway and quarantined files wait until the engine answers. Then apply with the EICAR test file ([production-setup.md](production-setup.md), "The check with made-up people").

When the scanner is down, a scan returns an error, the file stays in quarantine and the step retries with growing waits. Nothing is ever released from quarantine without a clean verdict. A hosted worker on the stand-in scanner raises a standing `scanner.fake` alert, and the production worker refuses to start on it.
