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

## Twilio (Video + SMS OTP)
**Package:** `twilio` (^5.12.1)
**Status:** WIRED, MISSING CREDENTIALS
**Powers:**
- Twilio Video access-token generation for in-app doctor↔patient video consultations (`src/video_helpers.js`, called from `src/routes/video.js` `/api/video/token/:appointmentId`)
- SMS OTP for mobile-app login (referenced in `src/routes/api/auth.js`) — currently fed a logging stub from `src/server.js`; the OTP is generated and stored in `otp_codes` but no SMS goes out until a real Twilio SMS sender module is wired
**Required env vars:**
- `VIDEO_CONSULTATION_ENABLED` — feature flag (defaults `false`)
- `TWILIO_ACCOUNT_SID` — **blank in `.env.example`**
- `TWILIO_AUTH_TOKEN` — **blank in `.env.example`** (also used as fallback API secret if dedicated key not configured)
- `TWILIO_API_KEY` — **blank in `.env.example`** (falls back to `ACCOUNT_SID`)
- `TWILIO_API_SECRET` — **blank in `.env.example`** (falls back to `AUTH_TOKEN`)
**Files:** `src/video_helpers.js`, `src/routes/video.js`, `src/routes/api/auth.js`, `src/server.js` (helper wiring)
**Notes:** Video token endpoint throws `TWILIO_CREDENTIALS_MISSING` at request time if not configured — fails open with a clear error. For SMS OTP: `src/server.js` passes a logging stub to `sendOtpViaTwilio` (returns `{stub: true}`); the call site at `src/routes/api/auth.js:159` already had a truthy guard so there was never a runtime crash, but the route response now distinguishes "OTP delivered" vs. "OTP generated, delivery not configured" so the mobile app and ops aren't misled. To enable real SMS delivery, add an `src/services/twilio_sms.js` module and wire it conditionally in `server.js` based on `TWILIO_ACCOUNT_SID`.

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

## Multer (file upload middleware)
**Package:** `multer` (^2.0.2)
**Status:** WIRED & ACTIVE
**Powers:** Multipart/form-data file upload handling for two routes: case file uploads (`src/routes/order_flow.js`) and prescription PDFs (`src/routes/prescriptions.js`).
**Required env vars:** None (local disk storage).
**Files:** `src/routes/order_flow.js`, `src/routes/prescriptions.js`
**Notes:** Uses `multer.diskStorage` — files land on the Render instance's local disk, which is **ephemeral** (lost on every deploy). **File loss on deploy is a known issue, fix deferred pending full reader-route audit, see TODO comments in `src/routes/order_flow.js` and `src/routes/prescriptions.js`.** A naive storage-backend swap is unsafe because both consumers store synthetic local paths (`file.filename`, not `file.path`) that downstream reader routes use to serve files back — those readers must be migrated in lockstep with the writer. Most patient files actually go through Uploadcare (client-side); multer is a fallback for direct uploads.

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
**Powers:** All WhatsApp notifications — case lifecycle updates, doctor broadcasts, SLA reminders, payment links, OTP delivery, critical admin alerts.
**Required env vars:**
- `WHATSAPP_ENABLED` — feature flag (default `true` in `.env.example`)
- `WHATSAPP_PHONE_NUMBER_ID` — **blank in `.env.example`**
- `WHATSAPP_ACCESS_TOKEN` — **blank in `.env.example`**
- `WHATSAPP_API_VERSION` — defaults to `v22.0`
- `ADMIN_PHONE` — for crash alerts (blank in `.env.example`)
**Files:** `src/notify/whatsapp.js`, `src/notify.js`, `src/notify/templates.js`, `src/notify/broadcast.js`, `src/critical-alert.js`
**Notes:** Templates must be approved in Meta Business Manager before they can be sent. Approved template names are listed in `src/notify/templates.js`. Failure mode: `sendWhatsApp` returns `{ok:false}` on missing creds — sender won't crash but no message goes out.

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
**Status:** WIRED, MISSING CREDENTIALS
**Powers:** Patient file uploads (medical imaging, lab reports) — client-side widget on portal/forms; server-side references for case file URLs.
**Required env vars:**
- `UPLOADCARE_PUBLIC_KEY` — **blank in `.env.example`** (also embedded in HTML widget)
- `UPLOADCARE_SECRET_KEY` — **blank in `.env.example`** (server-side ops)
**Files:** `src/routes/patient.js`, `src/routes/api/cases.js`, `src/routes/verify.js`, `src/middleware.js`, `portal.html` (widget public key hardcoded)
**Notes:** The portal widget currently has its public key hardcoded in `portal.html` (`data-public-key="879d1c89be9ce8198f71"`) — should be moved to env-driven template injection so prod/staging keys can differ.

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

`src/case_lifecycle.js` defines the canonical `CASE_STATUS` enum (DRAFT, SUBMITTED, PAID, ASSIGNED, IN_REVIEW, REJECTED_FILES, COMPLETED, SLA_BREACH, REASSIGNED, CANCELLED). Every transition below is a logical notification trigger. Items marked ✅ already wire a `queueNotification(...)` call somewhere in the codebase; ❌ are gaps where no email/WhatsApp send is attached today.

| Transition | Patient notification | Doctor notification | Admin notification |
|---|---|---|---|
| → SUBMITTED (intake received) | ✅ WhatsApp via `cases_intake` route returns reference; no async send | — | — |
| → PAID (payment confirmed) | ✅ `payment_success_patient` (whatsapp + email + internal) | ✅ `payment_success_doctor` if assigned | — |
| → ASSIGNED (doctor matched) | ❌ no patient notification on assignment | ✅ `order_assigned_doctor` / `order_reassigned_doctor` | — |
| ASSIGNED → IN_REVIEW (doctor accepts) | ✅ `order_status_accepted_patient` | — | — |
| ASSIGNED → REJECTED_FILES (more info) | ❌ logically warranted, no template wired | — | — |
| IN_REVIEW → COMPLETED (report ready) | ✅ `report_ready_patient` (multi-channel) | — | — |
| IN_REVIEW → REJECTED_FILES (mid-review) | ❌ no patient notification | — | — |
| REJECTED_FILES → ASSIGNED (files re-uploaded) | — | ❌ no doctor ping when patient re-uploads | — |
| → SLA_BREACH | — | ✅ `sla_breach` to assigned doctor | ✅ `sla_breach` to superadmin |
| → REASSIGNED | ❌ no patient notification | ✅ new doctor gets `order_reassigned_doctor` | — |
| → CANCELLED (within grace) | ❌ no `case_cancelled_refund` template wired | — | — |
| → CANCELLED (post-grace) | ❌ no `case_cancelled_no_refund` template wired | — | — |
| Payment unpaid reminders | ✅ `payment_reminder_30m` / `_6h` / `_24h` (in `case_lifecycle.js`) | — | — |
| SLA reminders | — | ✅ `sla_reminder_75` / `sla_reminder_90` | — |

**Gaps to fill if you want full coverage:** patient notifications on assignment / reassignment / cancellation, patient notification when more info is requested, doctor notification when patient re-uploads requested files. Templates are partially defined in `src/notify/templates.js` (`CASE_ASSIGNED`, `CASE_CANCELLED_REFUND`, `CASE_CANCELLED_NO_REFUND`, `DR_NEEDS_INFO`) but most aren't yet invoked from the lifecycle transition points.

---

## Recommendations

1. **Add a real Twilio SMS sender module** (e.g. `src/services/twilio_sms.js`) and wire it conditionally in `src/server.js` based on `TWILIO_ACCOUNT_SID`. The OTP route currently uses a logging stub from `server.js` and returns an honest "delivery not configured" response — no crash, but no SMS goes out either.
2. **Move Uploadcare public key out of `portal.html`.** Hardcoded keys in HTML can't be rotated per environment.
3. **Bundle Instagram dependencies (`openai`, `cloudinary`, raw Meta Graph)** into a single feature flag — if Instagram automation is paused, all three SDKs become attack surface for no benefit.
4. **Migrate `multer` upload destinations off local disk.** Render's filesystem is ephemeral; uploaded files vanish on every deploy.
5. **Plug the lifecycle notification gaps** (table above) — particularly patient notifications on doctor assignment and on cancellation, which are the most user-visible.
6. **Confirm in Render dashboard** that all credentials marked **MISSING CREDENTIALS** above are actually set. `.env.example` blank fields are not authoritative for production.
