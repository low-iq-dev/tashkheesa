# Tashkheesa — Third-Party Integrations
Last audited: April 2026

Static analysis of `package.json` dependencies, `src/` imports, and `.env.example`. Status reflects what the code does today, not what runtime credentials are present in Render. Where `.env.example` ships with a blank value the integration is marked **MISSING CREDENTIALS** — the developer must confirm the value is set in the Render dashboard before the feature works.

---

## Anthropic (Claude)
**Package:** `@anthropic-ai/sdk` (^0.78.0)
**Status:** WIRED & ACTIVE
**Powers:**
- Case intelligence pipeline — auto-summarise patient cases, extract findings, suggest triage (`src/case-intelligence.js`)
- Patient-facing AI assistant chat (`src/routes/ai_assistant.js`)
- AI image quality check on patient uploads — used during intake (`src/ai_image_check.js`, raw HTTPS not SDK)
- Triage support inside patient flow (`src/routes/patient.js` line ~710, raw HTTPS not SDK)
**Required env vars:**
- `ANTHROPIC_API_KEY` — Anthropic console API key
**Files:** `src/case-intelligence.js`, `src/routes/ai_assistant.js`, `src/ai_image_check.js`, `src/routes/patient.js`
**Notes:** `ANTHROPIC_API_KEY` is enforced at boot by `src/server.js` `validateCriticalEnvVars()`, alongside `JWT_SECRET` and `DATABASE_URL` — server refuses to start without it. Two code paths use the SDK; two use raw `https.request`. Consolidating onto the SDK would simplify error handling.

---

## Nodemailer (SMTP email)
**Package:** `nodemailer` (^8.0.1)
**Status:** WIRED, MISSING CREDENTIALS
**Powers:** All transactional email — password reset, account verification, case status notifications, appointment reminders, campaigns, report delivery.
**Required env vars:**
- `EMAIL_ENABLED` — feature flag, defaults to false in code (true in `.env.example`)
- `SMTP_HOST` — SMTP server hostname (`.env.example` default: `smtp.zoho.com`)
- `SMTP_PORT` — port (`.env.example` default: `465`)
- `SMTP_SECURE` — TLS flag (`.env.example` default: `true`)
- `SMTP_USER` — sender mailbox (`.env.example` default: `noreply@tashkheesa.com`)
- `SMTP_PASS` — **blank in `.env.example`** — must be set in Render
- `SMTP_FROM_EMAIL`, `SMTP_FROM_NAME` — From header (defaults present)
- `APP_URL` — used in email templates for links
**Files:** `src/services/emailService.js` (transport + template engine), `src/notification_worker.js`, `src/jobs/appointment_reminders.js`, `src/routes/auth.js`, `src/routes/api/auth.js`, `src/routes/reports.js`, `src/routes/campaigns.js`
**Notes:** `getTransporter()` returns `null` and logs a fatal if `SMTP_HOST`/`SMTP_USER`/`SMTP_PASS` aren't all set — every send call then short-circuits with `{ok:false, error:'smtp_not_configured'}`. Templates live in `src/templates/email/{en,ar}/*.hbs`. Verify `SMTP_PASS` is set in Render before relying on email in production.

---

## Twilio (Video only — SMS OTP path retired)
**Package:** `twilio` (^5.12.1)
**Status:** WIRED, MISSING CREDENTIALS (Video) — SMS OTP path removed
**Powers:**
- Twilio Video access-token generation for in-app doctor↔patient video consultations (`src/video_helpers.js`, called from `src/routes/video.js` `/api/video/token/:appointmentId`)
- ~~SMS OTP for mobile-app login~~ → **OTP delivery moved to WhatsApp Cloud API in 2026-04** (see WhatsApp entry below). The api_v1 helpers object still uses the legacy key name `sendOtpViaTwilio` — that name is now misleading; the value behind it is `src/services/whatsapp_otp.js`. Renaming the key is a one-line change but touches `src/routes/api/auth.js`, deferred for a separate cleanup.
**Required env vars:**
- `VIDEO_CONSULTATION_ENABLED` — feature flag (defaults `false`)
- `TWILIO_ACCOUNT_SID` — **blank in `.env.example`**
- `TWILIO_AUTH_TOKEN` — **blank in `.env.example`** (also used as fallback API secret if dedicated key not configured)
- `TWILIO_API_KEY` — **blank in `.env.example`** (falls back to `ACCOUNT_SID`)
- `TWILIO_API_SECRET` — **blank in `.env.example`** (falls back to `AUTH_TOKEN`)
**Files:** `src/video_helpers.js`, `src/routes/video.js`, `src/server.js` (Video helper wiring only — OTP wiring is now `src/services/whatsapp_otp.js`)
**Notes:** Video token endpoint throws `TWILIO_CREDENTIALS_MISSING` at request time if not configured — fails open with a clear error. The legacy SMS OTP stub in `src/server.js` was removed and replaced with the WhatsApp adapter. No need to add a Twilio SMS module — WhatsApp is the active OTP transport for the MENA patient base.

---

## OpenAI (DALL-E 3 image generation)
**Package:** `openai` (^6.22.0)
**Status:** WIRED, MISSING CREDENTIALS
**Powers:** DALL-E 3 image generation for Instagram marketing posts (only).
**Required env vars:**
- `OPENAI_API_KEY` — **blank in `.env.example`**
**Files:** `src/instagram/image_generator.js`
**Notes:** Used solely by the Instagram publisher. If Instagram automation is not active, this dependency is dormant. No fallback — calls fail at runtime if key is missing. Despite the `.env.example` comment "Optional: OpenAI fallback", code uses it as a hard requirement for image gen, not as a Claude fallback.

---

## Cloudinary (image hosting)
**Package:** `cloudinary` (^2.9.0)
**Status:** WIRED, MISSING CREDENTIALS
**Powers:** Permanent hosting of generated Instagram post images (DALL-E URLs are temporary; Cloudinary is the stable URL).
**Required env vars:**
- `CLOUDINARY_CLOUD_NAME` — **blank in `.env.example`**
- `CLOUDINARY_API_KEY` — **blank in `.env.example`**
- `CLOUDINARY_API_SECRET` — **blank in `.env.example`**
**Files:** `src/instagram/image_generator.js`, `src/instagram/routes.js`
**Notes:** Same scope as OpenAI — Instagram only. `cloudinary.config()` is called at module load with whatever env vars are present (silently produces a misconfigured client if blank); upload calls then fail at runtime.

---

## pg-boss (PostgreSQL job queue)
**Package:** `pg-boss` (^12.14.0)
**Status:** WIRED & ACTIVE
**Powers:** Durable async job queue for case-intelligence pipeline runs, doctor auto-assignment, and case reprocessing — backed by the same PostgreSQL DB as the app.
**Required env vars:**
- `DATABASE_URL` — same PG connection string as the rest of the app
**Files:** `src/job_queue.js`, called from `src/server.js`, `src/routes/order_flow.js`, `src/routes/patient.js`, `src/routes/payments.js`
**Notes:** Skipped if `DATABASE_URL` not set; falls back to direct synchronous execution. Only starts in `SLA_MODE=primary`. Uses its own schema in the same DB.

---

## Nodemailer (transactional email)
**Package:** `nodemailer` (latest)
**Status:** WIRED & ACTIVE — sends when `SMTP_PASS` is set, stubs (logs `[MAILER STUB]`) when not.
**Powers:** All transactional email out of the platform. Two API surfaces:
- Templated path (`sendEmail`, `sendRawEmail` — `src/services/emailService.js`): Handlebars templates from `src/templates/email/`, gated on `EMAIL_ENABLED=true`. Used by reports, auth, notification_worker, campaigns, mobile API auth, appointment reminders.
- Phase 4 lifecycle path (`sendMail` + `notify*` helpers in the same module): plain text + simple inline HTML, gated only on `SMTP_PASS`. Used by case lifecycle to send the 6 lifecycle emails listed below.
**Required env vars:** `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`, `SMTP_PORT` (default 465), `SMTP_SECURE` (default true), `SMTP_FROM_EMAIL`, `SMTP_FROM_NAME`. The templated path additionally requires `EMAIL_ENABLED=true`.
**Files:** `src/services/emailService.js`, `src/case_lifecycle.js`, `src/routes/api/cases_intake.js`, `src/routes/superadmin.js`, `src/routes/patient.js`
**Phase 4 lifecycle notifications (gated only on `SMTP_PASS`):**
- `notifyCaseReceived(patient, referenceId)` — fired from `cases_intake.js` after the COMMIT
- `notifyCaseAssigned(patient, referenceId, doctorName)` — fired from `assignDoctor()` in `case_lifecycle.js` (only on the initial PAID→ASSIGNED transition)
- `notifyCaseReassigned(patient, referenceId)` — fired from `reassignCase()` in `case_lifecycle.js`
- `notifyMoreInfoRequested(patient, referenceId, message)` — fired from the superadmin additional-files-approve route (NOT at doctor-request time, per the routing rule documented in `case_lifecycle.js:1455`)
- `notifyCaseCancelled(patient, referenceId, reason)` — fired from the superadmin cancel-order route
- `notifyDoctorFileUploaded(doctorEmail, referenceId, patientName)` — fired from `patient.js` after the patient uploads additional files
**Notes:** Every notification call is wrapped in try/catch in the calling code. A failed send is logged but never throws or rolls back the underlying DB transaction. Safe to deploy before `SMTP_PASS` is set in Render.

---

## Multer (file upload middleware)
**Package:** `multer` (^2.0.2)
**Status:** WIRED & ACTIVE
**Powers:** Multipart/form-data file upload handling for two routes: case file uploads (`src/routes/order_flow.js`) and prescription PDFs (`src/routes/prescriptions.js`). Both writers now use the shared memory-storage middleware in `src/middleware/upload.js` and push the buffer to Cloudflare R2 via `src/storage.js`.
**Required env vars:** None for multer itself; the R2 backend requires `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME` (see Cloudflare R2 entry).
**Files:** `src/middleware/upload.js`, `src/routes/order_flow.js`, `src/routes/prescriptions.js`
**Notes:** As of Phase 4 (2026-04), no upload path uses local disk — every upload goes through `multer.memoryStorage` so `req.file.buffer` is available, then `uploadFile()` writes it to R2 and returns a storage key that's persisted in the DB (`order_files.url`, `prescriptions.pdf_url`, `orders.report_url`, `report_exports.file_path`, `medical_records.file_url`). Reader routes generate short-lived signed URLs on demand via `getSignedDownloadUrl()`. Generated PDF reports (`src/report-generator.js`) also upload directly to R2 — the buffer is passed to `uploadFile({ folder: 'reports' })` without touching disk. The legacy disk-loss-on-deploy issue is fully resolved across all file types.

---

## node-cron (scheduled tasks)
**Package:** `node-cron` (^4.2.1)
**Status:** WIRED & ACTIVE
**Powers:** Scheduled SLA watcher sweep, video appointment reminders, Instagram campaign scheduler.
**Required env vars:** None.
**Files:** `src/server.js`, `src/video_scheduler.js`, `src/jobs/sla_watcher.js`
**Notes:** Cron jobs only start in `SLA_MODE=primary`. No external service.

---

## Direct HTTP integrations (no npm SDK)

These hit external services via raw `fetch` / `https.request`. They aren't in `package.json` as named SDKs but are critical to the platform.

### WhatsApp Cloud API (Meta)
**Status:** WIRED, MISSING CREDENTIALS
**Powers:** All WhatsApp notifications — case lifecycle updates, doctor broadcasts, SLA reminders, payment links, **mobile-app login OTP delivery (2026-04)**, critical admin alerts.
**Required env vars:**
- `WHATSAPP_ENABLED` — feature flag (default `true` in `.env.example`)
- `WHATSAPP_PHONE_NUMBER_ID` — **blank in `.env.example`**
- `WHATSAPP_ACCESS_TOKEN` — **blank in `.env.example`**
- `WHATSAPP_API_VERSION` — defaults to `v22.0`
- `WHATSAPP_OTP_TEMPLATE_NAME` — Meta authentication-category template name for OTP delivery (default `otp_verify_en`); **must exist in Meta Business Manager** and accept ONE body parameter (the OTP code)
- `WHATSAPP_OTP_TEMPLATE_LANG` — template language code for the OTP template (default `en`)
- `ADMIN_PHONE` — for crash alerts (blank in `.env.example`)
**Files:** `src/notify/whatsapp.js`, `src/notify.js`, `src/notify/templates.js`, `src/notify/whatsappTemplateMap.js`, `src/notify/broadcast.js`, `src/critical-alert.js`, `src/services/whatsapp_otp.js`
**Notes:** Templates must be approved in Meta Business Manager before they can be sent — `sendWhatsApp` only ever sends `type: 'template'`, never free-form text. The mapping from internal event names to Meta template names lives in `src/notify/whatsappTemplateMap.js`. The OTP path is separate: `src/services/whatsapp_otp.js` calls `sendWhatsApp({template: WHATSAPP_OTP_TEMPLATE_NAME, vars: { otp_code }})` directly, bypassing the template map (the OTP route is the only call site that needs to extract the code from the message string). Failure modes are graceful: missing `WHATSAPP_ACCESS_TOKEN` → stub (logs `[OTP WHATSAPP STUB]`, OTP route returns "delivery not configured"); `WHATSAPP_ENABLED` not `true` → also stub; template missing in Meta dashboard → `{ok:false, error}` from Graph API, OTP route still returns success but message text won't lie about delivery.

### Paymob (payments)
**Status:** WIRED, MISSING CREDENTIALS
**Powers:** Patient case payment processing (Egypt), HMAC webhook verification.
**Required env vars:**
- `PAYMOB_PUBLIC_KEY` — **blank in `.env.example`**
- `PAYMOB_SECRET_KEY` — **blank in `.env.example`**
- `PAYMOB_HMAC_SECRET` — **blank in `.env.example`** (primary webhook auth)
- `PAYMENT_WEBHOOK_SECRET` — legacy fallback (blank in `.env.example`)
**Files:** `src/routes/payments.js`, `src/paymob-hmac.js`
**Notes:** Webhook returns 503 if neither HMAC secret nor legacy secret is set — payments will silently not confirm. Production must have `PAYMOB_HMAC_SECRET` set.

### Uploadcare (file CDN)
**Status:** WIRED & ACTIVE — public key sourced from `UPLOADCARE_PUBLIC_KEY` env var. Falls back gracefully to a translated "uploader not configured" warning (`src/i18n.js:100,298`) when the env var is unset.
**Powers:** Patient file uploads (medical imaging, lab reports) — client-side widget on portal forms; server-side references for legacy case file URLs (Phase 2+ uploads now go to R2 — see Cloudflare R2 entry).
**Required env vars:**
- `UPLOADCARE_PUBLIC_KEY` — blank in `.env.example`; must be set in Render
- `UPLOADCARE_SECRET_KEY` — blank in `.env.example`; required for server-side ops
**Files:** `src/routes/patient.js` (passes the key into template locals at `:36-42` and `:1767-1768`), `src/views/patient_order_new.ejs`, `src/views/patient_order_upload.ejs` (widget mount points consuming the local), `src/routes/api/cases.js`, `src/routes/verify.js`, `src/middleware.js` (CSP allowlist).
**Notes:** No hardcoded keys in any committed file — verified by repo-wide grep. The widget reads the key from `window.UPLOADCARE_PUBLIC_KEY`, set inline in the EJS view from the route local before the Uploadcare script loads.

### Meta Graph API (Instagram publisher)
**Status:** WIRED, MISSING CREDENTIALS
**Powers:** Auto-publishing scheduled posts to Instagram Business account.
**Required env vars:**
- `META_APP_ID`, `META_APP_SECRET` — Meta app credentials
- `IG_ACCESS_TOKEN` — long-lived page access token (**blank in `.env.example`**)
- `IG_BUSINESS_ACCOUNT_ID`, `FB_PAGE_ID` — target account IDs
- `MEDIA_BASE_URL` — public URL prefix for hosted media (default `https://tashkheesa.com`)
**Files:** `src/instagram/config.js`, `src/instagram/routes.js`, `src/instagram/scheduler.js`, `src/instagram/image_generator.js`, `src/instagram/publisher.js`
**Notes:** Scheduler short-circuits if `IG_ACCESS_TOKEN` not set (logs and skips). Bundles with OpenAI + Cloudinary as a single feature group — disable all three together if Instagram automation isn't in scope.

---

## Case lifecycle status transitions — notifications expected

`src/case_lifecycle.js` defines the canonical `CASE_STATUS` enum (DRAFT, SUBMITTED, PAID, ASSIGNED, IN_REVIEW, REJECTED_FILES, COMPLETED, SLA_BREACH, REASSIGNED, CANCELLED). Every transition below is a logical notification trigger. Items marked ✅ already wire a notification call somewhere in the codebase.

| Transition | Patient notification | Doctor notification | Admin notification |
|---|---|---|---|
| → SUBMITTED (intake received) | ✅ `notifyCaseReceived` email + WhatsApp via `cases_intake` | — | — |
| → PAID (payment confirmed) | ✅ `payment_success_patient` (whatsapp + email + internal) | ✅ `payment_success_doctor` if assigned | — |
| → ASSIGNED (doctor matched) | ✅ `notifyCaseAssigned` email | ✅ `order_assigned_doctor` / `order_reassigned_doctor` | — |
| ASSIGNED → IN_REVIEW (doctor accepts) | ✅ `order_status_accepted_patient` | — | — |
| ASSIGNED → REJECTED_FILES (more info) | ✅ `notifyMoreInfoRequested` email | — | — |
| IN_REVIEW → COMPLETED (report ready) | ✅ `report_ready_patient` (multi-channel) | — | — |
| IN_REVIEW → REJECTED_FILES (mid-review) | ✅ `notifyMoreInfoRequested` email | — | — |
| REJECTED_FILES → ASSIGNED (files re-uploaded) | — | ✅ `notifyDoctorFileUploaded` email | — |
| → SLA_BREACH | — | ✅ `sla_breach` to assigned doctor | ✅ `sla_breach` to superadmin |
| → REASSIGNED | ✅ `notifyCaseReassigned` email | ✅ new doctor gets `order_reassigned_doctor` | — |
| → CANCELLED (within grace) | ✅ `notifyCaseCancelled` email | — | — |
| → CANCELLED (post-grace) | ✅ `notifyCaseCancelled` email | — | — |
| Payment unpaid reminders | ✅ `payment_reminder_30m` / `_6h` / `_24h` (in `case_lifecycle.js`) | — | — |
| SLA reminders | — | ✅ `sla_reminder_75` / `sla_reminder_90` | — |

All lifecycle email notifications were wired in commit `579054c` via 6 `notify*` helpers in `src/services/emailService.js` (see Phase 4 lifecycle notifications section above). WhatsApp template coverage for these transitions remains a future enhancement — the email path is the primary channel.

---

## Recommendations

1. ~~Add a real Twilio SMS sender module.~~ ✅ Resolved differently in 2026-04: OTP delivery routes through WhatsApp Cloud API (`src/services/whatsapp_otp.js`) instead of SMS — better fit for the MENA patient base. Pending follow-up: create the Meta authentication template named `otp_verify_en` (or whatever `WHATSAPP_OTP_TEMPLATE_NAME` is set to) in WhatsApp Business Manager so deliveries actually land.
2. ~~Move Uploadcare public key out of `portal.html`.~~ ✅ Resolved in two steps: (a) the live patient-facing surfaces (`src/views/patient_order_new.ejs`, `src/views/patient_order_upload.ejs`) had already been migrated to read `UPLOADCARE_PUBLIC_KEY` from route locals (`src/routes/patient.js:36-42`); (b) the now-dead `portal.html` at the repo root — which still embedded the key but was no longer referenced by any route or static mount — was deleted. Verified: `grep -r 879d1c89 .` returns zero matches across all tracked files.
3. **Bundle Instagram dependencies (`openai`, `cloudinary`, raw Meta Graph)** into a single feature flag — if Instagram automation is paused, all three SDKs become attack surface for no benefit.
4. ~~Migrate `multer` upload destinations off local disk.~~ ✅ Done in Phases 1-4 (2026-04): all writers (case files, prescriptions, generated PDF reports) use memory storage + Cloudflare R2 via `src/storage.js`; reader routes serve via signed URLs. No file path touches local disk.
5. ~~Plug the lifecycle notification gaps.~~ ✅ Resolved in commit `579054c` (2026-04) — 6 lifecycle email notifications wired via `notify*` helpers in `src/services/emailService.js`: case received, assigned, reassigned, more info requested, cancelled, doctor file uploaded. All transitions in the table above now have at least email coverage.
6. **Confirm in Render dashboard** that all credentials marked **MISSING CREDENTIALS** above are actually set. `.env.example` blank fields are not authoritative for production.
