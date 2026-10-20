# Résumé storage: private bucket, direct uploads, quarantine, audited reads

Status: built and tested against the in-memory store and the fake scanner on 22 September 2026 under founder decision 2
(`docs/spec/19` §G). Not yet exercised against the staging bucket. A ClamAV adapter exists since 30 September
(`SCAN_PROVIDER=clamav`, tested against a stand-in clamd); the engine itself is a service the founder starts on Railway
("Running ClamAV on Railway" below). Until it runs, the fake stands in and a production worker raises a standing
`scanner.fake` alert: that is a real-data blocker (`docs/readiness/20` blocker 8), not a staging blocker.

## How it works

1. **Upload.** On the apply page a small script (served under the page's nonce; no third-party code) asks the
   application for an upload authorization (`POST /careers/:slug/jobs/:roleId/upload-intent` with the file's name, size
   and type), sends the file straight to storage with a presigned single-object PUT that lives five minutes and is
   pinned to one content type, and submits the form with a sealed grant instead of the file. Without script, or when
   the direct upload fails, the form posts the file itself as before (through the application; the hosting platform
   caps those bodies at 4.5 MB, so files over 4 MB need the direct path). Inbound email attachments follow the same
   road as the form. Nothing about the person leaves the page except the file's name, size and type. A grant attaches
   its file to one submission (`document.upload_used` on the role); sent again it is refused like an expired grant,
   before the file is looked at, so the answer never shows whether the first submission was new or a repeat. A repeat
   submission's file is deleted at once.
2. **Quarantine.** Every file first lives under `quarantine/<company>/<role>/<random>.<ext>` with the document row in
   status `quarantined`. Nobody can open it: the staff download route answers 409 for anything not `clean`.
3. **Check and scan (worker).** The intake workflow's `validate` step (`packages/workflows/src/documents.ts`) reads the
   bytes, judges them by signature and structure (`packages/contracts/src/security/file-inspection.ts`: PDF, .docx or
   UTF-8 text only; programs, encrypted or macro-bearing documents, archives, malformed, empty or oversized files are
   refused; a declared type that contradicts the bytes is refused), then asks the scanner. A scanner outage leaves the
   file in quarantine and the step retries. A refused file is removed at once and the reason recorded
   (`document.rejected` event and audit record); the application goes on without a résumé and the owner sees why.
4. **Promote.** A clean file moves to `<company>/<candidate>/<application>/<random>.<ext>` (never the person's
   filename), the quarantine copy is deleted, the checksum recorded, the text extracted. Only then does the
   `extract` step read the text.
5. **Read.** Staff who may read the application open the file through `GET
   /api/v1/applications/:id/documents/:documentId/file`, which audits `document.read` (who, which file, from where)
   and redirects to a presigned GET that lives two minutes and serves the file as an attachment. No bucket is public;
   no permanent file URL exists; keys are never sent to the browser.
6. **Delete.** A fulfilled deletion request removes the object, marks the row `deleted` and audits `document.deleted`.

Audit actions: `document.uploaded`, `document.read`, `document.rejected`, `document.deleted` (`document.replaced` is
reserved; release 1 has no path that replaces a file). Events: `document.upload_authorized`, `document.upload_used`,
`document.uploaded`, `document.validated`, `document.rejected`, `document.deleted`. None carries file contents.

## The staging bucket (founder-run, one screen at a time)

The application talks to Supabase Storage over its S3-compatible endpoint with the project's **S3 access keys**: a
storage-only credential that cannot reach the database, Auth or Vault, and never the service-role key. The keys are not
bucket-scoped at the provider, so the project holds exactly one bucket for this application. No cloud SDK is used.

1. Supabase dashboard, project `recruiting-os-staging`, **Storage**, **New bucket**: name `resumes`, **Private** (the
   default; never public), file size limit `8 MB`, allowed MIME types `application/pdf`,
   `application/vnd.openxmlformats-officedocument.wordprocessingml.document`, `text/plain`, `text/markdown`, and the
   logo types `image/png`, `image/jpeg`, `image/webp` (company logos go to the same bucket,
   `apps/api/src/routes/company-settings.ts`). The apply form's reading note (`quarantine/…/<upload>.read.json`) is
   saved as `text/plain` (20 October 2026), so it needs no type of its own; a bucket that refuses a type answers the
   write with an error and the file is not kept.
2. **Storage**, **Settings**: global file size limit at least 8 MB (the per-bucket limit cannot exceed it).
3. **Storage**, **S3 Configuration**: enable the S3 protocol; note the endpoint and region shown there.
4. **Storage**, **S3 Configuration**, **Access keys**, **New access key**: description `recruiting-os-staging-app`.
   Save the access key id and the secret access key in 1Password, vault "Recruiting OS Staging", never in chat.
5. Environment variables (Vercel project `recruiting-os`, staging environment; Railway service `worker`):

   | Variable | Value | Sensitive |
   |---|---|---|
   | `STORAGE_PROVIDER` | `supabase` | no |
   | `STORAGE_BUCKET` | `resumes` | no |
   | `STORAGE_S3_ENDPOINT` | `https://vjuaiyjmtrenbrmujvtc.storage.supabase.co/storage/v1/s3` (the direct storage hostname the documentation recommends; the S3 Configuration page shows the exact value) | no |
   | `STORAGE_S3_REGION` | `us-west-2` (West US, Oregon) | no |
   | `STORAGE_S3_ACCESS_KEY_ID` | from step 4 | treat as sensitive |
   | `STORAGE_S3_SECRET_ACCESS_KEY` | from step 4 | **yes** (sealed in Railway; sensitive in Vercel) |

   The adapter refuses to start if any of these is missing and names the variable. In production `STORAGE_PROVIDER`
   must be `supabase`; the application will not boot on disk or memory storage there.
6. Revoke or rotate: **S3 Configuration**, **Access keys**, delete the key pair and create a new one; enter the new
   values; redeploy. A presigned URL already issued dies with the key.

## Running ClamAV on Railway

The scanner speaks clamd's own TCP protocol (`INSTREAM`, `PING`), so the engine is the official image and nothing
else: no API in between, no file leaves Railway's private network. The worker is the only process that scans; the
Vercel app keeps `SCAN_PROVIDER=fake` because it never opens a quarantined file.

1. Railway, project `recruiting-os-staging`, **New**, **Docker Image**, image `clamav/clamav:stable` (the official
   image on Docker Hub, maintained by Cisco Talos). Name the service `clamav`.
2. Service **Settings**: no public networking (leave **Generate Domain** unclicked); **Private Networking** on (it is
   on by default; the service is then reachable from the worker as `clamav.railway.internal`). The image listens on
   port `3310` and refreshes its signatures itself (`freshclam` runs inside the container); it needs about 1.5 GB of
   memory once the signatures are loaded, so keep the workspace's memory limit above that. Optional variables on the
   `clamav` service: `CLAMAV_NO_MILTER=true` (nothing uses the mail filter) and `CLAMD_STARTUP_TIMEOUT=1800` (the
   first start downloads the signatures, which can take a few minutes).
3. Worker service, **Variables**: `SCAN_PROVIDER=clamav`, `CLAMAV_HOST=clamav.railway.internal`, `CLAMAV_PORT=3310`
   (the default), `CLAMAV_TIMEOUT_MS=20000` (the default; an 8 MB file over private networking scans in well under
   that). None is a secret. Redeploy the worker.
4. Verify in the worker's deploy log: no `[scanner] clamav did not answer the boot check` line (that line means the
   host or port is wrong, or clamd is still loading signatures; the worker runs anyway and quarantined files wait,
   retried by the intake workflow, until the engine answers). Then apply on staging with the EICAR test file: the
   document is refused with `infected`, and the `document.rejected` event names the engine `clamav` and the signature.
5. Spend: about $15 to $25 a month of compute for the always-on engine (`docs/spec/21`); raise the workspace hard
   limit accordingly, or the whole workspace goes offline at the limit.

What a scan outage looks like: the scanner returns `error` (a refused connection, a closed socket, or no reply within
`CLAMAV_TIMEOUT_MS`), the file stays in quarantine, the step retries with backoff, and the adapter reports
`not_connected` on the console's integrations page until the next successful scan or PING. Nothing is ever released
from quarantine without a `clean` verdict.

## Known limitation: attachments that arrive by email (H9)

The inbound webhook runs on Vercel, whose request body limit is 4.5 MB. Postmark posts each attachment base64-encoded
(about a third larger than the file) together with the message text, so an application forwarded by email with an
attachment over about 3 MB is refused by the platform before the application code runs: Postmark sees a 413, retries
for a while, then records the delivery as failed in its inbound activity page. Nothing reaches `inbound_emails`, and
the candidate is not told, because nobody in the path knows who they are. Files uploaded on the apply page are not
affected: the direct-to-storage upload takes up to 8 MB.

Mitigation for the recruiter or owner who notices a missing application (Postmark's activity page names the sender):
ask the candidate for the direct apply link so they upload the file on the page, or to send a smaller file. Postmark's
inbound stream can also be told to drop attachments over a size, which turns the refusal into an application with no
résumé and the message text kept; that setting is the founder's call once the intake domain exists. Lifted only by
moving the inbound webhook off the platform's function limits, recorded as a follow-up in the register.

## Staging verification (`docs/readiness/03` §1a)

Apply with a PDF through a real browser and confirm: the file appears under `quarantine/` and then under the company's
prefix in the bucket (Storage, Explorer), the document row goes `quarantined` → `clean`, the owner can open it from the
candidate's page and an audit record `document.read` appears, a renamed program is refused with `executable`, and the
EICAR test file is refused with `infected`. Confirm the bucket is still private and that the browser's policy report
shows no `connect-src` violation for the storage origin. Then record blockers 6 and 7 in `docs/readiness/20` as
verified on staging; blocker 8 stays open until a real scanner is authorized.
