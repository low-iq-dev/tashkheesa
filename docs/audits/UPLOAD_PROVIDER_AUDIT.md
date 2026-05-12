# Upload Provider Audit

**Date:** 2026-05-12
**Branch:** `main`
**Investigator:** read-only audit. No source modified.
**Sources read:** `src/storage.js`, `src/middleware/upload.js`, `src/routes/{order_flow,patient,prescriptions,doctor,api/cases,api_v1,reports,verify,ops}.js`, `src/instagram/image_generator.js`, `src/views/{patient_new_case,patient_order,public_case_new,privacy,patient_prescription_detail,portal_doctor_profile}.ejs`, `src/middleware.js`, `src/server.js`, `src/i18n.js`, `package.json`, `.env / .env.example / .env.production`, `src/migrations/{001,017,023,043}*.sql`, `docs/INTEGRATIONS.md`, `docs/audits/SIDE_ISSUES_BACKLOG.md`, `CLAUDE_CODE_BRIEF_PHOTO_UPLOAD_DEBUG.md`, `git log --since='90 days ago'` filtered on upload paths, local Postgres `\d order_files` + `error_logs` aggregates.

---

## TL;DR

Three providers are live in different lanes. **Cloudflare R2 is already the storage backend for everything server-side** (doctor photos, signatures, prescription PDFs, generated reports, `order_flow.js` patient case files). **Uploadcare is still the client-side widget** the wizard renders for patient case files (`src/views/patient_new_case.ejs:879`) and the mobile API expects `uploadcareUuid` strings (`src/routes/api/cases.js:243`). **Cloudinary is single-purpose** — Instagram DALL-E images only.

The user complaint "file upload thing still isn't working" needs prod log evidence to localize (local DB has no upload error rows), but the recent commit cluster strongly fingers the Uploadcare widget rendering path on the patient wizard — see §4. Side issue **#52 (DEFERRED)** already names the next move: migrate Uploadcare 3.x → Blocks v1.x to drop `'unsafe-eval'` from CSP. **R2 can replace Uploadcare entirely** with one new POST endpoint and a column rename; the legacy `/files/:id` redirect already handles both backends.

---

## 1. Current providers

### 1a. Active in production

| Provider | Package | First-class env keys | Status | Lane |
|---|---|---|---|---|
| **Cloudflare R2** (S3-compatible) | `@aws-sdk/client-s3@^3.1030.0`, `@aws-sdk/s3-request-presigner@^3.1030.0` | `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME` | **ACTIVE** — boots, head-checks bucket, writes server-side. Vars present in local `.env:70-73` and `.env.example:147-150`. Vars **not present** in committed `.env.production` (set via Render dashboard, hence the "[R2] Connected to tashkheesa-files bucket" log line). | All server-originated bytes |
| **Uploadcare** (CDN + widget) | none — CDN script `https://ucarecdn.com/libs/widget/3.x/uploadcare.full.min.js` | `UPLOADCARE_PUBLIC_KEY` (validated at boot, `src/server.js:84-87`), `UPLOADCARE_SECRET_KEY` (env-set, **never read** anywhere — `src/server.js:89` documents the gap; `verify.js:100-103` reads only the public key with three fallback names) | **ACTIVE** — patient wizard, mobile API, legacy CDN URLs in `order_files` rows | Patient-originated bytes (web wizard + mobile) |
| **Cloudinary** | `cloudinary@^2.9.0` | `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` (all blank in `.env.example`, set in Render) | **ACTIVE** — DALL-E 3 image hosting only | Instagram automation (single use) |
| **Multer** | `multer@^2.0.2` | none | **ACTIVE** — single shared `multer.memoryStorage()` instance in `src/middleware/upload.js:39-65`; consumed by 3 route files | Multipart parsing only; bytes go to R2 from the route |

### 1b. Searched for, **not present**

`filestack`, `bunny`, `supabase storage`, `@supabase/storage-js` — zero matches across `src/`, `scripts/`, `tests/`, `package.json`.

### 1c. Per-match grep results (file:line, what it does, dead/active)

**Cloudflare R2 / AWS-SDK / multer (server-side)**

| file:line | What it does | Active? |
|---|---|---|
| `src/storage.js:5-32` | Creates the singleton `S3Client`, region `auto`, endpoint = `R2_ENDPOINT`, bucket = `R2_BUCKET_NAME`. Boot-time `HeadBucketCommand` health check (`:90-107`) emits the "[R2] Connected to ..." line and routes failure to `error_logs` via `logErrorToDb`. | Active |
| `src/storage.js:43-58` | `uploadFile({ buffer, originalname, mimetype, folder, filename? })` → returns R2 key. Optional `filename` lets callers force a deterministic key (used for `<timestamp>.<ext>` cache-busted doctor photo/signature names). | Active |
| `src/storage.js:69-77` | `getSignedDownloadUrl(key, expiresIn=3600s, { downloadName? })` — signed URL with optional `Content-Disposition: attachment` for downloads. | Active |
| `src/storage.js:83-85` | `deleteFile(key)` — used for "remove previous photo" cleanup. | Active |
| `src/middleware/upload.js:39-65` | The shared multer instance. `memoryStorage()`, 50 MB limit, ext + MIME allowlist (.jpg/.jpeg/.png/.gif/.webp/.tiff/.pdf/.doc/.docx/.dcm/.heic), DICOM-tolerant for `application/octet-stream`, hard-blocks `.exe/.sh/.js/.php/...`. | Active |
| `src/routes/order_flow.js:15-16, 71-85` | `attachFileToOrder()` — multer buffer → `uploadFile({ folder: 'orders/<orderId>' })` → INSERT into `order_files (id, order_id, url, label, created_at)`. **`url` here is an R2 key, not a URL.** Comment at `:19-30` documents this and lists the 4 reader sites that remap `url` → `/files/:id`. | Active |
| `src/routes/prescriptions.js:16-17, 142-149` | Doctor uploads prescription PDF → `uploadFile({ folder: 'prescriptions' })` → key stored in `prescriptions.pdf_url`. | Active |
| `src/routes/doctor.js:24-25, 2870-2960` | `POST /portal/doctor/profile/photo` — multer + R2 (folder `doctor-photos/<doctor_id>/`, deterministic filename `<ts>.<ext>`); image-size validation; previous-key cleanup; `users.profile_photo_url` updated. | Active |
| `src/routes/doctor.js:3032-3110` | `POST /portal/doctor/profile/signature` — same pattern, folder `doctor-signatures/<doctor_id>/`, `users.signature_url`. | Active |
| `src/routes/doctor.js:2987-3010, 3138-3165` | `GET /portal/doctor/profile/photo/:id` and `.../signature/:id` — auth-gated, reads R2 key from DB, 302 to `getSignedDownloadUrl(key, 3600)`. | Active |
| `src/routes/api_v1.js:19` | Imports `getSignedDownloadUrl` for mobile API file serving. | Active |
| `src/routes/reports.js:11` | Patient case-report download path; signed-URL redirect. | Active |
| `src/routes/order_flow.js:144` | Reader: lists `order_files.url` for an order. | Active |
| `src/server.js:99-123` | Documents R2 env-var requirements as part of boot env-var doc table. | Active (boot doc) |
| `src/server.js:507-525` | The unified `/files/:id` route. **Branches by stored value:** if it's an `http(s)://` URL (legacy Uploadcare row) → 302 redirect direct. Otherwise treats as R2 key → 302 to signed URL. Both paths log to `error_logs` on failure. | Active |
| `src/report-generator.js:6, 561, 774, 930` | Server-generated PDF reports → `uploadFile({ folder: 'reports' })`. Three call sites for distinct report types. | Active |
| `src/views/privacy.ejs:27, 34` | Privacy policy says: "All medical files are encrypted in transit using HTTPS (TLS 1.2+) and encrypted at rest on Cloudflare R2 storage." | Active legal text |
| `src/views/patient_prescription_detail.ejs:33`, `src/views/portal_doctor_profile.ejs:184` | View comments referencing R2 key storage convention. | Active comments |

**Uploadcare (client-side widget + mobile API contract)**

| file:line | What it does | Active? |
|---|---|---|
| `src/server.js:84-96` | Boot env-var doc gate for `UPLOADCARE_PUBLIC_KEY`. Critical inline note (`:89-96`): **`UPLOADCARE_SECRET_KEY` is intentionally NOT validated** — the docs claim it's needed for signed uploads / secure delivery / webhook signature verification / REST API calls, but **no code in this repo reads `process.env.UPLOADCARE_SECRET_KEY`** (verified by grep — zero hits outside that comment, `.env.example`, `INTEGRATIONS.md`). | Active key validator + documented gap |
| `src/server.js:346-356` | CSP allowlist: `img-src/font-src/style-src/script-src/connect-src/frame-src` all explicitly include `https://ucarecdn.com`, `https://upload.uploadcare.com`, `https://api.uploadcare.com`, `https://uploadcare.com`. **`script-src` requires `'unsafe-eval'`** — comment at `:349-353` explains: "required by Uploadcare File Uploader 3.x — it compiles templates from string at runtime via `new Function()`". This is what side issue **#52** wants to remove. | Active CSP |
| `src/middleware.js:15-62` | A second helmet/CSP block (older code path, unclear which wins — both append the same allowlist). | Likely shadowed by `server.js:346-356`; no harm but worth verifying |
| `src/views/patient_new_case.ejs:877-930` | Patient wizard step 2 — loads the Uploadcare 3.x widget script, sets `window.UPLOADCARE_PUBLIC_KEY` from EJS local, builds a custom drop-zone form, calls `window.uploadcare.fileFrom('object', file).done(...)`, takes `info.cdnUrl` and submits it via a hidden `file_url_input`. | Active — primary patient upload UX |
| `src/views/patient_order.ejs:646-668` | Patient order detail page — same widget; calls `window.uploadcare.openDialog(null, { multiple:false, tabs:'file url' })`. | Active |
| `src/views/public_case_new.ejs:119-126` | Pre-auth public case form — does **not** load the widget; only accepts pasted Uploadcare/Drive URLs as text. Defensive fallback for very large files. | Active fallback |
| `src/routes/patient.js:75-77` | `uploadcareLocals` factory — single source of truth for `uploadcarePublicKey` + `uploaderConfigured` template locals. Spread into 7 distinct `res.render(...)` call sites (`:1429, 2021, 2034, 2133, 2221, 2244, 2388, 2798, 1392, 3311`). | Active — every patient-facing render that touches the wizard |
| `src/routes/api/cases.js:117-138` | Mobile API `GET /cases/:id` — reads `order_files.uploadcare_uuid`, builds `cdnUrl = https://ucarecdn.com/${uploadcareUuid}/` for legacy app builds, plus the new portal-issued `url = /files/:id`. | Active — mobile API contract |
| `src/routes/api/cases.js:236-244` | Mobile API `POST /cases` — accepts `files: [{ uploadcareUuid, filename, mimeType, size }]` and INSERTs into `order_files (uploadcare_uuid, ...)`. **Mobile clients upload to Uploadcare directly and post the UUID; the server never touches the bytes.** | Active — mobile case-create contract |
| `src/routes/api/cases.js:251-256` | Fire-and-forget AI image-quality check fetches the file via `https://ucarecdn.com/${uploadcareUuid}/`. | Active — depends on the CDN URL being reachable |
| `src/routes/verify.js:99-125` | `/verify` admin readiness page — pulls `UPLOADCARE_PUBLIC_KEY` (with two legacy fallbacks `UPLOADCARE_PUBLIC` and `UPLOADCARE_KEY`); renders presence + suffix in a "Keys" panel. | Active diagnostic |
| `src/routes/ops.js:976-978` | `/ops/...` endpoint exposes `uploadcare_public_key_set/length/prefix` for ops debugging. | Active diagnostic |
| `src/routes/order_flow.js:21-22` | Comment: `/files/:id` route returns "the legacy Uploadcare URL for pre-Phase-2 rows". | Active comment |
| `src/routes/patient.js:1956, 2234, 3079-3135, 3283` | Patient endpoints that explicitly reference Uploadcare in comments / handle CDN URLs. | Active |
| `src/i18n.js:122, 380` | EN + AR i18n strings: "Files cannot be uploaded until UPLOADCARE_PUBLIC_KEY is set in .env and the server is restarted." | Active warning |
| `src/ai_image_check.js:116` | Comment: image-quality validator accepts UploadCare CDN URLs. | Active |

**Cloudinary**

| file:line | What it does | Active? |
|---|---|---|
| `src/instagram/image_generator.js:7, 11-15, 74-92` | DALL-E 3 returns a temporary URL → `cloudinary.uploader.upload(imageUrl, { public_id })` → returns `secure_url`. Single helper `uploadToCloudinary()`. | Active — Instagram only |
| `src/instagram/routes.js:176, 209` | Persists `result.cloudinaryUrl` into the Instagram-post DB row. | Active |
| `src/views/superadmin_instagram.ejs:175, 363` | Cloudinary URL pattern detection for thumbnail rewriting (`/upload/` → `/upload/w_400,q_80,f_auto/`). | Active |
| `src/server.js:346` | CSP `img-src` allows `https://res.cloudinary.com`. | Active CSP |

**aws-sdk references that are NOT R2:** none. The two `@aws-sdk/*` packages are used exclusively by `src/storage.js` against the R2 endpoint.

**multer references that are NOT the shared middleware:** none. All three callers (`order_flow.js`, `prescriptions.js`, `doctor.js`) `require('../middleware/upload')`. There is no second multer instance with disk storage anywhere.

---

## 2. Storage backend — where do bytes actually live?

| Bytes | Backend | Persisted as | Read path |
|---|---|---|---|
| Patient case files via mobile app | **Uploadcare CDN** (`ucarecdn.com`) | `order_files.uploadcare_uuid` (TEXT) — see migration `043_codify_mobile_api_schema.sql:68` | `/files/:id` 302 → `https://ucarecdn.com/<uuid>/` (legacy branch in `server.js:507`) OR direct CDN link via `cdnUrl` field for old app builds |
| Patient case files via portal wizard (`patient_new_case.ejs`) | **Uploadcare CDN** | `order_files.url` = `https://ucarecdn.com/<uuid>/...` (the widget gives us a full CDN URL via `info.cdnUrl`; stored as-is) | Same `/files/:id` legacy branch — detected by `^https?://` regex |
| Patient case files via portal `order_flow.js` (`/order/:id/upload`) | **Cloudflare R2** (bucket `tashkheesa-files`) | `order_files.url` = R2 key like `orders/<orderId>/<uuid>.<ext>` | `/files/:id` → R2-key branch → `getSignedDownloadUrl(key, 3600)` |
| Doctor profile photo | **Cloudflare R2** | `users.profile_photo_url` = R2 key `doctor-photos/<doctor_id>/<ts>.<ext>` | `/portal/doctor/profile/photo/:id` → 302 to signed URL |
| Doctor signature | **Cloudflare R2** | `users.signature_url` = R2 key `doctor-signatures/<doctor_id>/<ts>.<ext>` | `/portal/doctor/profile/signature/:id` → 302 to signed URL |
| Prescription PDF (doctor uploads or generated) | **Cloudflare R2** | `prescriptions.pdf_url` = R2 key `prescriptions/<uuid>.<ext>` | Signed URL redirect |
| Generated PDF reports | **Cloudflare R2** | `orders.report_url`, `report_exports.file_path`, `medical_records.file_url` (per `INTEGRATIONS.md`'s multer entry) — folder `reports/` | Signed URL redirect |
| Instagram post images | **Cloudinary** | `instagram_posts.image_urls` (JSON column) | Direct `https://res.cloudinary.com/...` (public CDN, no auth) |

**Confirming the R2-already-connected claim from your earlier conversation:** yes. `src/storage.js:90-107` runs `HeadBucketCommand` at boot and emits exactly `[R2] Connected to <BUCKET> bucket`. The bucket name comes from `R2_BUCKET_NAME`, which (based on your "tashkheesa-files" wording in the brief) is set in the Render dashboard but not in the committed `.env.production` (only `.env` and `.env.example` carry R2 vars locally).

**Important nuance:** the column `order_files.url` is **multi-mode** today. Same column holds (a) full Uploadcare CDN HTTPS URLs from the wizard, (b) R2 keys from `order_flow.js`, (c) historical synthetic local paths like `orders/<id>/<filename>` from the disk-storage era which are unrecoverable (`order_flow.js:28-29` comment). The `/files/:id` route disambiguates by `^https?://` regex. This is the lever for the migration: change patient-wizard to push to R2 and the `url` column becomes uniformly R2 keys.

---

## 3. Upload flow surfaces — every place a file enters the system

### 3a. Patient case file uploads (multiple paths — this is the messy one)

| Surface | Where | Provider | Bytes route |
|---|---|---|---|
| Portal new-case wizard step 2 | `src/views/patient_new_case.ejs:879-930`, locals from `src/routes/patient.js:1392 + 2021 + ...` | **Uploadcare 3.x widget** (`window.uploadcare.fileFrom('object', file)`) | Browser → Uploadcare CDN → `info.cdnUrl` → hidden form field → server stores URL in `order_files.url` |
| Portal patient order detail (additional files) | `src/views/patient_order.ejs:646-668`, plus `src/routes/patient.js:3079-3135` (V2 messages-tab attachment) | **Uploadcare 3.x widget** (`window.uploadcare.openDialog`) | Same — CDN URL persisted; `notifyDoctorFileUploaded` fires after |
| Portal pre-auth public case form (fallback) | `src/views/public_case_new.ejs:119-126` | **Pasted URL only** (Uploadcare/Drive URL fields, no widget) | Server receives `file_url_1`, `file_url_2` strings; no upload happens server-side |
| Portal `order_flow.js` `POST /order/:orderId/upload` | `src/routes/order_flow.js:71-85` (`attachFileToOrder()`); registered routes use multer | **Multer + R2** | Browser → multer memory → R2 (`orders/<id>/<uuid>.ext`) → `order_files.url` = R2 key. **Note:** `PRE_LAUNCH_MODE = false` at `:51`, so order routes are live; commit `742b464` "retired standalone /portal/patient/orders/:id/upload uploader" so the patient wizard no longer routes here — but the route + multer pipeline is wired and used by other call paths. |
| Mobile API `POST /api/v1/cases` | `src/routes/api/cases.js:236-244` | **Client → Uploadcare** (server never sees bytes); server only stores the UUID | App uploads via Uploadcare's mobile SDK → POSTs `{ files: [{ uploadcareUuid, ... }] }` → server INSERT into `order_files.uploadcare_uuid` |

### 3b. Doctor profile photo

`POST /portal/doctor/profile/photo` (`src/routes/doctor.js:2870-2960`) — **multer + R2**, `users.profile_photo_url`. Read via `GET /portal/doctor/profile/photo/:id`.

### 3c. Doctor signature

`POST /portal/doctor/profile/signature` (`src/routes/doctor.js:3032-3110`) — **multer + R2**, `users.signature_url`. Read via `GET /portal/doctor/profile/signature/:id`.

### 3d. Prescription PDF

`POST` in `src/routes/prescriptions.js:142-149` — doctor uploads a prescription PDF, **multer + R2**, `prescriptions.pdf_url`.

### 3e. Generated PDF reports

`src/report-generator.js:561, 774, 930` — three distinct report types, all **server-generated, written to R2** (`folder: 'reports'`). No user upload, but bytes flow through `uploadFile()`.

### 3f. Instagram post images

`src/instagram/image_generator.js:74-92` — **server-side fetch from DALL-E URL → Cloudinary upload**. No user upload surface. Single-purpose, isolated; not relevant to the Uploadcare conversation.

### 3g. Surfaces NOT found

- No patient avatar upload (patients have no profile photo in the schema).
- No "case attachment" upload outside the four patient surfaces above and the doctor reject-files / additional-info request flow (which is a doctor-side `comments` text submit, not a file upload).
- No bulk-upload admin endpoint.

---

## 4. What's actually broken

### 4a. Local DB has nothing useful

```sql
SELECT category, COUNT(*) FROM error_logs
 WHERE created_at > NOW() - INTERVAL '7 days' GROUP BY category ORDER BY 2 DESC;
```

```
 category   | count
------------+------
 email_send |  432
 (null)     |   78
```

No `r2_bucket`, `doctor_upload`, `patient_upload` rows in **local** Postgres. This is expected — local is dev, no real upload traffic. **The audit cannot determine the live bug from local data; you must query production.**

### 4b. Categories the app uses for upload errors (so you know what to filter on in prod)

Searched `src/` for `category: '...'` in `logErrorToDb` calls touching upload code:

- `category: 'r2_bucket'` — `src/storage.js:101` (boot-time bucket head-check failure)
- `category: 'doctor_upload'` — `src/routes/doctor.js` 7 distinct sites covering photo/signature upload + remove + serve + image-size validation
- `category: 'patient_upload'` — `src/routes/patient.js:3422`
- (No `category: 'r2_upload'` or `'r2_key_serve'` — failures from `uploadFile()` called inside route handlers will be logged with the calling route's category, not a unified one.)

### 4c. To get the actual prod evidence, run

```sql
-- Recent upload-related failures
SELECT context, COUNT(*) AS n, MAX(created_at) AS latest, MIN(message) AS sample
  FROM error_logs
 WHERE created_at > NOW() - INTERVAL '7 days'
   AND ( category IN ('r2_bucket','doctor_upload','patient_upload')
      OR context ILIKE '%photo%' OR context ILIKE '%upload%'
      OR context ILIKE '%signature%' OR context ILIKE '%pdf%'
      OR context ILIKE '%file%' )
 GROUP BY context
 ORDER BY n DESC;
```

Plus — `/ops/errors` admin view surfaces these without psql access (per Theme 8 Phase 6 commit `35acd58`).

### 4d. Recent commit cluster strongly suggests where the breakage was

`git log --since='14 days ago'` filtered to upload paths showed these CSP/Uploadcare-rendering fixes shipped in close succession:

| SHA | Subject |
|---|---|
| `c3bf0bf` | fix(patient): pass uploadcareLocals to all new-case render paths (P3-VIEW-2) |
| `e0f0183` | fix(csp): pass cspNonce explicitly to head + foot partials in patient_new_case.ejs |
| `3425094` | fix(csp): pass cspNonce to all render call-sites + verify __nonceAttr uses raw output across views |
| `e2a40e3` | diag(csp): instrument CSP nonce flow at middleware, render-call, and EJS-scope |
| `23616a9` | fix(csp): attach nonce to req in middleware + dual-read in patient render calls |
| `17aae43` | fix(patient): propagate cspNonce to all inline scripts in patient_new_case.ejs |
| `742b464` | fix(patient): retire standalone /portal/patient/orders/:id/upload uploader |

This is a multi-attempt "the patient wizard's Uploadcare widget wasn't loading because of CSP nonce mismatch" debugging arc. If "still isn't working" was reported recently, the most likely hypothesis is **either the CSP-nonce path regressed on a newer view, or the Uploadcare widget itself is failing client-side** (network blocked, key wrong, browser ad-blocker eating ucarecdn.com).

### 4e. Older photo-upload debugging brief on disk

`CLAUDE_CODE_BRIEF_PHOTO_UPLOAD_DEBUG.md` (April 28, 2026) describes **two failed attempts** to fix doctor profile photo upload (`fec70a5`, `5cc5863`) before the eventual wire-up commit `01d135a feat(doctor-profile): wire up profile photo upload / remove / serve`. The brief itself is a useful template for "when in doubt, curl the endpoint and read the multer error" — that flow still applies if the user means doctor-photo specifically.

### 4f. Disambiguate before fixing

The phrase "file upload thing still isn't working" is ambiguous across the surfaces in §3. To avoid the third failed guess, ask the user one question:

1. **Which page + which button?** "Patient new-case wizard step 2 dropzone" vs "Doctor → Profile → Change photo" vs "Doctor → Prescriptions → Attach PDF" vs "Mobile app case upload" — these are four entirely different code paths and have nothing in common except multer (and only three of the four use multer).

If the answer is the patient wizard, the prior-probability ranking is: CSP nonce regression → Uploadcare key missing in prod env → ad-blocker / corp firewall blocking ucarecdn.com → widget version drift. If doctor photo, the brief at §4e is the template. If prescription PDF or doctor signature, look at the multer fileFilter rejections and R2 boot-time connectivity.

---

## 5. Existing infrastructure that could replace Uploadcare

### 5a. Cloudflare R2 — already paid for, already connected, already does this

R2 currently handles **every server-side upload path** (doctor photos, signatures, prescriptions, server-generated reports, the `order_flow.js` patient case files). The S3 client, multer middleware, signed-URL reader, and unified `/files/:id` redirect all exist and work. Migrating Uploadcare's remaining lane (patient wizard + mobile API) requires:

| Step | Effort | Touches |
|---|---|---|
| Add `POST /api/v1/cases/:id/files` (or similar) accepting multipart, using shared multer + `uploadFile({ folder: 'orders/<orderId>' })` | small | new route in `src/routes/api/cases.js` (or `cases_intake.js`) |
| Replace patient wizard `Uploadcare.fileFrom(...)` with browser `fetch(uploadEndpoint, { body: FormData })` | small-medium | `src/views/patient_new_case.ejs:877-930` rewrite (~50 LOC) and `src/views/patient_order.ejs:646-668` |
| Migrate the mobile-API contract (`POST /cases` body shape) — accept either `uploadcareUuid` (legacy, deprecation period) or new `fileId` from the new direct-upload endpoint | small | `src/routes/api/cases.js:236-244`; coordinate with mobile team |
| Drop `script-src 'unsafe-eval'` + the ucarecdn.com allowlist entries from CSP | trivial | `src/server.js:346-356`, `src/middleware.js:15-62` |
| Backfill / leave-in-place: existing `order_files.uploadcare_uuid` rows continue to work via the legacy branch in `/files/:id` (no migration required if you accept the dual-mode column forever) | none / optional | `src/server.js:507-525` already handles both |
| Deprovision Uploadcare account once observability shows no new ucarecdn writes for N days | n/a | env removal, billing |

This **directly resolves side issue #52** (deferred Uploadcare 3.x → Blocks v1.x migration), since the cleanest path off `'unsafe-eval'` is "stop using Uploadcare's web SDK at all".

### 5b. Cloudinary — wrong tool for this job

Already in the bill, but it's positioned for image transforms + CDN delivery, not arbitrary blob storage with private signed access. Medical files (DICOM, PDF, lab reports) don't benefit from Cloudinary's image-pipeline strengths and would need separate signed-delivery setup. **Skip.**

### 5c. Other infra in env / package.json

Scanned all three env files and `package.json`. Nothing else is a credible storage replacement:
- `pg-boss` — job queue, not storage
- `pdfkit`, `pdf-parse` — PDF generation/parsing, not storage
- `nodemailer`, `resend`, `twilio` — communications
- `@anthropic-ai/sdk`, `openai` — AI
- `paymob*` env vars — payments

**R2 is the only realistic replacement candidate, and it's not a maybe — it's already doing 80% of the job.**

---

## 6. Other findings worth surfacing

### 6a. `UPLOADCARE_SECRET_KEY` is configured but unread

`src/server.js:89-96` documents this gap: env var is set in Render but **no code reads `process.env.UPLOADCARE_SECRET_KEY`**. Confirmed by repo-wide grep. This means: signed uploads, signed delivery (private files), webhook signature verification, and REST API calls (file delete, project metadata) are all unimplemented today. Patient files on Uploadcare CDN are **publicly addressable** to anyone who knows the CDN URL — there is no auth gate at ucarecdn.com itself; the only gate is "the URL is hard to guess". For medical files, this is a regulatory smell. Migrating to R2 fixes this since R2 reads go through `/files/:id` → signed URL with 1-hour expiry.

### 6b. `order_files.url` is a multi-mode column

Same TEXT column holds: HTTPS Uploadcare CDN URLs, R2 storage keys, and historical broken local paths. The disambiguation lives entirely in `src/server.js:507-525` regex. Any new reader that bypasses `/files/:id` and tries to use `order_files.url` directly will be wrong for at least one of the three modes. This is documented in `src/routes/order_flow.js:19-30` but is a footgun.

### 6c. There are two CSP allowlist blocks

`src/middleware.js:15-62` and `src/server.js:346-356` both register helmet/CSP with overlapping but slightly different directives. Worth confirming which one wins on the patient wizard surface (probably `server.js`, since that's the most recently edited per the commit cluster in §4d). If `middleware.js` is dead, consider deleting it as part of any CSP cleanup.

### 6d. Side issues backlog already names this

`docs/audits/SIDE_ISSUES_BACKLOG.md` row #52 (DEFERRED, P2): "Migrate Uploadcare File Uploader 3.x → Blocks v1.x." Marked Internal-policy gate ("rewrite scope (file uploader is on every patient case-create path; needs UAT)"). Row #56 was a duplicate, consolidated to #52. The "replace Uploadcare with R2 entirely" path subsumes #52.

### 6e. Two helmet/CSP configs may render the `'unsafe-eval'` removal a two-place edit

If you do migrate off Uploadcare, removing `'unsafe-eval'` cleanly requires editing `src/server.js:354` AND auditing `src/middleware.js` to confirm it doesn't re-add it (or doesn't run at all). Quick before-after CSP diff in DevTools on both an authenticated and unauthenticated page would confirm.

---

## 7. What this audit did **not** do

- Did not query the **production** Postgres `error_logs` table (no prod credentials in this environment). The §4c query is the recommended next step.
- Did not run the patient wizard or doctor profile in a browser to reproduce a live failure — read-only audit per the brief.
- Did not check Render dashboard env-var presence for R2_*, UPLOADCARE_*, CLOUDINARY_* — inferred from code + .env.example + the boot-log signal you mentioned.
- Did not run the AI image-quality validator end-to-end against an Uploadcare CDN URL — `src/ai_image_check.js` is wired (`src/routes/api/cases.js:251-256`) but not exercised here.
- Did not audit Uploadcare account-side configuration (project settings, signed-uploads toggle, webhook subscriptions) — that's all out of repo.

---

## 8. Recommended next moves (not implemented; for your decision)

1. **First, get the prod evidence** — run §4c query, post-process by surface, confirm whether the breakage is in the patient wizard, doctor photo, prescription PDF, or somewhere else. This determines whether you're firefighting or planning.
2. **Disambiguate "file upload thing"** with the user — see §4f, one question.
3. **Plan-track the R2-replaces-Uploadcare migration** — it resolves side issue #52, kills `'unsafe-eval'`, removes one third-party dependency, removes one bill, and closes a real privacy gap (§6a). Effort sketch in §5a.
4. **Tactical: add a unified `category: 'file_upload'`** field across the three categories in §4b so future audits don't have to OR-chain context strings.
