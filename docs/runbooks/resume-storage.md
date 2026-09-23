# Résumé storage: private bucket, direct uploads, quarantine, audited reads

Status: built and tested against the in-memory store and the fake scanner on 22 September 2026 under founder decision 2
(`docs/spec/19` §G). Not yet exercised against the staging bucket. Malware scanning is a fake until a real engine is
authorized: that is a real-data blocker (`docs/readiness/20` blocker 8), not a staging blocker.

## How it works

1. **Upload.** On the apply page a small script (served under the page's nonce; no third-party code) asks the
   application for an upload authorization (`POST /careers/:slug/jobs/:roleId/upload-intent` with the file's name, size
   and type), sends the file straight to storage with a presigned single-object PUT that lives five minutes and is
   pinned to one content type, and submits the form with a sealed grant instead of the file. Without script, or when
   the direct upload fails, the form posts the file itself as before (through the application; the hosting platform
   caps those bodies at 4.5 MB, so files over 4 MB need the direct path). Inbound email attachments follow the same
   road as the form. Nothing about the person leaves the page except the file's name, size and type.
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
reserved; release 1 has no path that replaces a file). Events: `document.upload_authorized`, `document.uploaded`,
`document.validated`, `document.rejected`, `document.deleted`. None carries file contents.

## The staging bucket (founder-run, one screen at a time)

The application talks to Supabase Storage over its S3-compatible endpoint with the project's **S3 access keys**: a
storage-only credential that cannot reach the database, Auth or Vault, and never the service-role key. The keys are not
bucket-scoped at the provider, so the project holds exactly one bucket for this application. No cloud SDK is used.

1. Supabase dashboard, project `recruiting-os-staging`, **Storage**, **New bucket**: name `resumes`, **Private** (the
   default; never public), file size limit `8 MB`, allowed MIME types `application/pdf`,
   `application/vnd.openxmlformats-officedocument.wordprocessingml.document`, `text/plain`, `text/markdown`.
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

## Staging verification (`docs/readiness/03` §1a)

Apply with a PDF through a real browser and confirm: the file appears under `quarantine/` and then under the company's
prefix in the bucket (Storage, Explorer), the document row goes `quarantined` → `clean`, the owner can open it from the
candidate's page and an audit record `document.read` appears, a renamed program is refused with `executable`, and the
EICAR test file is refused with `infected`. Confirm the bucket is still private and that the browser's policy report
shows no `connect-src` violation for the storage origin. Then record blockers 6 and 7 in `docs/readiness/20` as
verified on staging; blocker 8 stays open until a real scanner is authorized.
