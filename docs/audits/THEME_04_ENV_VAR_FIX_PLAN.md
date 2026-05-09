# Theme 4 — Silently-Dead Service Env Vars: Fix Plan

**Status:** Scoping only. No code changes in this commit.
**Reference:** `docs/audits/COMPREHENSIVE_PRE_LAUNCH_AUDIT_2026-05-06.md`
**Sister themes:** Theme 1 (schema drift), Theme 3 (CSRF), Theme 5 (pool saturation), Theme 10 (i18n).
**Scope:** Environment-variable documentation, validation, and dead-flag cleanup before public launch.

---

> **NOTE — possible-but-mitigated security finding (not promoted to ALERT)**
>
> `src/middleware/requireJWT.js:13` contains an undocumented silent fallback:
> ```javascript
> const JWT_SECRET = process.env.JWT_SECRET || process.env.SESSION_SECRET;
> ```
> In a vacuum this would let `SESSION_SECRET` silently sign access + refresh JWTs.
> **In practice today it cannot fire**, because the IIFE at `src/server.js:51–68` already
> calls `process.exit(1)` when `JWT_SECRET` is unset/blank, so `requireJWT.js` never
> loads with `JWT_SECRET=undefined`. The fallback is dead code.
>
> The risk is **defense-in-depth, not active**: if anyone removes or refactors that IIFE
> in the future (e.g. moving env validation into `bootCheck.js`), the fallback would
> silently re-activate. Recommendation: kill the fallback in this theme so the dependency
> graph matches the documented contract. Treated as Sub-issue C below; not blocking launch.

---

## 1. Executive Summary

The codebase relies on environment variables in three dimensions — *defined in code*,
*documented in `.env.example`*, *validated at boot* — and the three sets do not agree.
This audit confirms the original report's claim: at least 5 production-required env
vars are silent dependencies (read by the code, absent from `.env.example`), the SMTP
block in `.env.example` is dead documentation since the 2026-04-30 Resend migration,
and `PAYMOB_LIVE_PAYMENTS` would crash live payments because it flips UI to live mode
while `services/paymob.js` hard-throws when `PAYMOB_MODE!=='test'`.

Boot validation today is split across three layers (`bootCheck.js`, the
`validateCriticalEnvVars` IIFE in `server.js`, and a Theme-5-added fail-fast in
`job_queue.js`) and covers 7 distinct vars. The audit's "3 of 14+" framing was based
on the IIFE alone; the real shortfall is closer to ~10 missing validators across PII
encryption (`NATIONAL_ID_ENCRYPTION_KEY`), payments (6 PAYMOB keys), email
(`RESEND_API_KEY`), file storage (4 R2 keys), and security tokens (`UNSUBSCRIBE_SECRET`,
`TASH_API_KEY`, `PUBLIC_ORDER_API_KEY`). Sub-issues A–E below propose targeted fixes;
no fix touches schema or business logic.

---

## 2. Current State

### Validators in place today (verified)

| Layer | File / Lines | Vars validated | Strictness |
|---|---|---|---|
| 1 | `src/bootCheck.js:13–139` (called at `server.js:48`) | `MODE`, `SLA_MODE`, `SLA_PRIMARY_TOKEN` (conditional), `ALLOW_PRIMARY_IN_DEV` (conditional), `BASIC_AUTH_USER`, `BASIC_AUTH_PASS`, `DATABASE_URL` | Strict in staging/production; warn in dev for `DATABASE_URL` |
| 2 | `src/server.js:51–68` `validateCriticalEnvVars()` IIFE | `JWT_SECRET`, `DATABASE_URL` (dup), `ANTHROPIC_API_KEY` | Always strict; `process.exit(1)` on miss |
| 3 | `src/job_queue.js:20–53` (Theme 5) | `DATABASE_URL_DIRECT` | Fatal in production/staging; warn in dev |

Verbatim of the IIFE (the audit's "boot validator covers 3 vars"):
```javascript
// src/server.js:51-68
(function validateCriticalEnvVars() {
  var required = ['JWT_SECRET', 'DATABASE_URL', 'ANTHROPIC_API_KEY'];
  var missing = [];
  required.forEach(function(varName) {
    var value = process.env[varName];
    if (!value || String(value).trim() === '') {
      missing.push(varName);
    }
  });
  if (missing.length > 0) {
    logFatal('FATAL: Missing required environment variables: ' + missing.join(', '));
    process.exit(1);
  }
  logVerbose('All required env vars present: ' + required.join(', '));
})();
```

### Sub-issue A — `RESEND_API_KEY` undocumented + SMTP block dead doc

**Reads in code:**

| File | Line | Snippet |
|---|---|---|
| `src/services/emailService.js` | 40 | `const RESEND_API_KEY = process.env.RESEND_API_KEY \|\| '';` |
| `src/services/emailService.js` | 152–155 | If unset: `fatal('[email] Resend not configured — RESEND_API_KEY required')` then returns `null`. Templated email throws here. |
| `src/services/emailService.js` | 532–536 | Low-level `sendMail()`: if unset, `console.warn('[MAILER STUB] …')` and returns `{stub: true}` — **silent no-op**. Lifecycle notifications (case-received, case-assigned, etc.) take this path. |

**`.env.example` coverage:** `RESEND_API_KEY` is **not listed**. Lines 106–114 document
an SMTP block (`SMTP_HOST=smtp.zoho.com`, `SMTP_PORT=465`, `SMTP_USER`, `SMTP_PASS`,
`SMTP_SECURE`, `SMTP_FROM_EMAIL`, `SMTP_FROM_NAME`, `EMAIL_ENABLED`).

**SMTP status:** **Dead transport.** No `nodemailer` imports, no `createTransport`,
no `sendMail` over SMTP. `src/services/emailService.js:15` documents the
2026-04-30 migration to Resend HTTP API. The `SMTP_FROM_EMAIL` / `SMTP_FROM_NAME`
vars are reused as the Resend "from" address only (legacy variable names retained
for compatibility per `emailService.js:82–87`); they do not configure transport.
`SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_SECURE` are unused.

**Boot validator coverage:** none. `RESEND_API_KEY` is not validated by any of the
three layers above.

**Failure mode if unset on Render:**
- *Templated email path* (`sendEmail`, `sendRawEmail`, password reset, payment
  receipt, etc.): `getTransporter()` calls `fatal()` on first invocation.
- *Lifecycle notification path* (`notifyCaseReceived`, `notifyCaseAssigned`,
  `notifyDoctorFileUploaded`, etc.): silent stub. Patients never receive their
  case-received email; the server logs a `[MAILER STUB]` warning per send.
  This is the dangerous path — the platform looks healthy.

User confirms `RESEND_API_KEY` *is* set on Render today, so production is currently
fine. The risk is a future env-var rotation or a fresh deploy without the key.

### Sub-issue B — `PAYMOB_LIVE_PAYMENTS` contradiction

**The flag has two independent consumers and they're not synchronised:**

```javascript
// src/routes/patient.js:1332 — UI flag exposed to the new-case wizard EJS
paymobLiveMode: String(process.env.PAYMOB_LIVE_PAYMENTS || '').trim().toLowerCase() === 'true',

// src/routes/patient.js:1690 — POST /patient/new-case/step5 server-side branch
const liveMode = String(process.env.PAYMOB_LIVE_PAYMENTS || '').trim().toLowerCase() === 'true';
if (!liveMode) {
  return res.redirect('/portal/patient/orders/' + encodeURIComponent(orderId) + '/payment-success?stub=1');
}
// live: getOrCreatePaymentUrl(...) → paymobService.createIntention(...)
```

```javascript
// src/services/paymob.js:34-46 — backend hard-gate, reads a DIFFERENT flag
function _assertTestMode() {
  const mode = String(process.env.PAYMOB_MODE || 'test').toLowerCase();
  if (mode !== 'test') {
    const e = new Error('PAYMOB_MODE=' + mode + ' not permitted — services/paymob.js is gated to test mode.');
    e.code = 'PAYMOB_MODE_NOT_TEST';
    throw e;
  }
}
```

`createIntention` and every public entry point of `paymob.js` calls `_assertTestMode()`
first. So:

- **Today (PAYMOB_LIVE_PAYMENTS unset, PAYMOB_MODE=test):** UI shows test, server
  short-circuits to a stub success route that calls `caseLifecycle.markCasePaid(orderId)`
  *without touching Paymob*. **Order is marked PAID with no real payment taken.** This
  is fine for pre-launch testing but is a **launch-day landmine**: at go-live, somebody
  must remember to set `PAYMOB_LIVE_PAYMENTS=true` AND change `PAYMOB_MODE` AND ship a
  code change to remove the `_assertTestMode()` gate. None of these are documented
  together.
- **Hypothetical (PAYMOB_LIVE_PAYMENTS=true, PAYMOB_MODE=test):** UI redirects to
  Paymob; server calls `createIntention()`; `_assertTestMode()` throws
  `PAYMOB_MODE_NOT_TEST`; `patient.js:1706` catches and redirects to
  `?failed=1`. Patient sees "payment failed" with no diagnosable cause.

**.env.example coverage:** `PAYMOB_LIVE_PAYMENTS` is **not listed**. `PAYMOB_MODE` is
documented at line 91 (`# test | live (live not permitted in code yet)`).

**Boot validator coverage:** none for any `PAYMOB_*` var.

### Sub-issue C — `SESSION_SECRET` undocumented `JWT_SECRET` fallback

**The fallback (verified at file open):**
```javascript
// src/middleware/requireJWT.js:13-14
const JWT_SECRET = process.env.JWT_SECRET || process.env.SESSION_SECRET;
if (!JWT_SECRET) throw new Error('FATAL: JWT_SECRET environment variable is not set');
```

This module is the JWT issuer/verifier for `/api/v1/*` routes (mobile app + future
external API consumers). `auth.js` and `routes/auth.js` use `process.env.JWT_SECRET`
**directly with no fallback** — they're consistent with the IIFE.

**Why the fallback is dead in practice (today):** `server.js:51–68` IIFE checks
`JWT_SECRET` independently, with the same emptiness rules (`!value || trim() === ''`),
and calls `process.exit(1)` on miss. The IIFE runs at module init time during
`require('./server')`, before any HTTP request. So if `JWT_SECRET` is unset the boot
fails before `requireJWT.js:13` is ever evaluated against a missing var.

**Why the fallback is still a problem:**
1. It's undocumented — `.env.example:23–25` shows `JWT_SECRET` and
   `SESSION_COOKIE_NAME` only. No mention of `SESSION_SECRET`. A deployer who happens
   to set `SESSION_SECRET` per Express convention would have it silently swallowed if
   the IIFE were ever weakened.
2. It's defence-in-depth-negative — three different files (`auth.js`,
   `routes/auth.js`, `routes/ops.js`) read `process.env.JWT_SECRET` directly with no
   fallback. `requireJWT.js` is the odd one out.
3. It hides intent — a future maintainer reading `requireJWT.js` would reasonably
   conclude that `SESSION_SECRET` is a supported alternate, and configure it as such.

`.env.example` does not document `SESSION_SECRET` at all. It documents
`SESSION_COOKIE_NAME=tashkheesa_portal` (line 25), which is unrelated.

**No hardcoded default secrets found** in src/ (greps for `fallback-secret`,
`dev-secret`, `your-secret-here`, `changeme` returned zero hits, with one exception:
`src/routes/tash-api.js:7` has `TASH_API_KEY_DEFAULT = 'tash-default-key-change-me'`
that is explicitly checked-and-rejected as a fatal in production at line 9–13. That
pattern is correct.)

### Sub-issue D — Boot validator coverage

**Master env-var inventory.** A grep of `process.env\.` across `src/` and `app.js`
yields ~110 distinct env-var names. Filtering out scripts-only vars and Render-injected
build metadata, the production-relevant inventory is:

| Var | Class | Read in (file:line) | In `.env.example`? | Validated at boot? | Should validate? |
|---|---|---|---|---|---|
| `MODE` | REQUIRED-PROD | `bootCheck.js:17` | ✅ | ✅ (bootCheck) | ✅ already |
| `NODE_ENV` | OPTIONAL | `auth.js:141`, `bootCheck.js:17` | ✅ | partial (MODE fallback) | ❌ MODE is canonical |
| `BASE_URL` | REQUIRED-PROD | `middleware.js:9`, `server.js:503` | ✅ | ❌ | ✅ add |
| `APP_URL` | REQUIRED-PROD | `notification_worker.js:95–99`, `middleware.js:10` | ✅ | ❌ | ✅ add |
| `JWT_SECRET` | REQUIRED-PROD | `auth.js:39,46`, `routes/auth.js:116`, `routes/ops.js:114`, `middleware/requireJWT.js:13` | ✅ | ✅ (IIFE) | ✅ already |
| `SESSION_SECRET` | DEAD (silent JWT fallback) | `middleware/requireJWT.js:13` | ❌ | ❌ | remove from code (sub-issue C) |
| `NATIONAL_ID_ENCRYPTION_KEY` | REQUIRED-PROD | `services/national-id.js:23`, `routes/auth.js:825` | ✅ (line 40) | ❌ | ✅ add (PII at rest) |
| `BASIC_AUTH_USER` | REQUIRED-PROD | `bootCheck.js:73` | ✅ | ✅ (bootCheck, non-dev) | ✅ already |
| `BASIC_AUTH_PASS` | REQUIRED-PROD | `bootCheck.js:74` | ✅ | ✅ (bootCheck, non-dev) | ✅ already |
| `CSRF_MODE` | OPTIONAL | `middleware.js:25` | ✅ | ❌ | ❌ (safe default) |
| `DATABASE_URL` | REQUIRED-PROD | `bootCheck.js:89`, `pg.js:51`, `job_queue.js:21` | ✅ | ✅ (bootCheck + IIFE) | ✅ already |
| `DATABASE_URL_DIRECT` | REQUIRED-PROD (staging+prod) | `pg.js:73`, `job_queue.js:20` | ✅ (line 54) | ✅ (Theme 5 — `job_queue.js:28`) | ✅ already |
| `PG_SSL` | OPTIONAL | `pg.js:52` | ✅ | ❌ | ❌ (safe default) |
| `PG_POOL_MAX` | OPTIONAL | `pg.js:38` | ✅ (commented) | ❌ | ⚠️ range-validate (5–14, see Theme 5) |
| `PG_POOL_CONNECT_TIMEOUT_MS` | OPTIONAL | `pg.js:39` | ✅ (commented) | ❌ | ❌ |
| `PG_POOL_IDLE_TIMEOUT_MS` | OPTIONAL | `pg.js:40` | ✅ (commented) | ❌ | ❌ |
| `PG_STATEMENT_TIMEOUT_MS` | OPTIONAL | `pg.js:48` | ✅ (commented) | ❌ | ⚠️ range-validate |
| `SLA_MODE` | REQUIRED-PROD | `bootCheck.js:30` | ✅ | ✅ (bootCheck) | ✅ already |
| `SLA_PRIMARY_TOKEN` | REQUIRED-CONDITIONAL | `bootCheck.js:48` | ✅ | ✅ (bootCheck conditional) | ✅ already |
| `SLA_ENFORCEMENT_ENABLED` | OPTIONAL | `server.js` | ✅ | ❌ | ❌ |
| `SLA_ENFORCEMENT_INTERVAL_MS` | OPTIONAL | `server.js` | ✅ | ❌ | ❌ |
| `SLA_DRY_RUN` | OPTIONAL | `slaDryRun.js:1` | ✅ | ❌ | ❌ |
| `SLA_REMINDER_MINUTES` | OPTIONAL | `server.js` | ✅ | ❌ | ❌ |
| `SLA_AUTO_PAUSE_BREACHES` | OPTIONAL | `case_sla_worker.js` | ✅ | ❌ | ❌ |
| `SLA_AUTO_PAUSE_WINDOW_DAYS` | OPTIONAL | `case_sla_worker.js` | ✅ | ❌ | ❌ |
| `PAYMOB_PUBLIC_KEY` | REQUIRED-PROD | `services/paymob.js:186`, `routes/video.js:257` | ✅ | ❌ | ✅ add |
| `PAYMOB_SECRET_KEY` | REQUIRED-PROD | `services/paymob.js:100` | ✅ | ❌ | ✅ add |
| `PAYMOB_HMAC_SECRET` | REQUIRED-PROD | `services/paymob.js:98`, `routes/payments.js:198`, `routes/video.js:289` | ✅ | ❌ | ✅ add |
| `PAYMOB_CARD_INTEGRATION_ID` | REQUIRED-PROD | `services/paymob.js:180` | ✅ | ❌ | ✅ add |
| `PAYMOB_NOTIFICATION_URL` | REQUIRED-PROD | `services/paymob.js:192` | ✅ | ❌ | ✅ add |
| `PAYMOB_MODE` | REQUIRED-PROD | `services/paymob.js:40` | ✅ | ❌ | ✅ add |
| `PAYMOB_LIVE_PAYMENTS` | DEAD (sub-issue B) | `routes/patient.js:1332,1690,1773` | ❌ | ❌ | remove (sub-issue B) |
| `TASH_API_KEY` | REQUIRED-PROD | `routes/tash-api.js:6` | ✅ | partial (per-module fail-fast) | ✅ centralise |
| `PUBLIC_ORDER_API_KEY` | REQUIRED-PROD | `routes/public_orders.js:30` | ✅ | ❌ | ✅ add |
| `UNSUBSCRIBE_SECRET` | REQUIRED-PROD | `routes/campaigns.js:14` | ✅ | partial (per-module fail-fast) | ✅ centralise |
| `ANTHROPIC_API_KEY` | REQUIRED-PROD | `case-intelligence.js:17`, `ai_image_check.js:8`, `routes/order_flow.js:320`, `routes/patient.js:912` | ✅ | ✅ (IIFE) | ✅ already |
| `OPENAI_API_KEY` | OPTIONAL | (fallback only) | ✅ | ❌ | ❌ |
| `UPLOADCARE_PUBLIC_KEY` | REQUIRED-PROD (signup) | `routes/auth.js:825` | ✅ | ❌ | ✅ add |
| `UPLOADCARE_SECRET_KEY` | REQUIRED-PROD (signup) | (sign uploads) | ✅ | ❌ | ✅ add |
| `RESEND_API_KEY` | REQUIRED-PROD | `services/emailService.js:40` | **❌** | ❌ | ✅ add (sub-issue A) |
| `EMAIL_ENABLED` | OPTIONAL | `notify.js:17`, `middleware.js:26` | ✅ | ❌ | ❌ |
| `EMAIL_GUARD_STRICT` | OPTIONAL | `services/emailService.js:43` | ✅ | ❌ | ❌ |
| `SMTP_HOST` | DEAD | (none) | ✅ | ❌ | remove from `.env.example` |
| `SMTP_PORT` | DEAD | (none) | ✅ | ❌ | remove from `.env.example` |
| `SMTP_SECURE` | DEAD | (none) | ✅ | ❌ | remove from `.env.example` |
| `SMTP_USER` | DEAD | (none) | ✅ | ❌ | remove from `.env.example` |
| `SMTP_PASS` | DEAD | (none) | ✅ | ❌ | remove from `.env.example` |
| `SMTP_FROM_EMAIL` | OPTIONAL (Resend "from") | `services/emailService.js:86` | ✅ | ❌ | ❌ (rename or annotate) |
| `SMTP_FROM_NAME` | OPTIONAL (Resend "from") | `services/emailService.js:87` | ✅ | ❌ | ❌ (rename or annotate) |
| `WHATSAPP_ENABLED` | OPTIONAL | `notify.js:17` | ✅ | ❌ | ❌ (feature flag) |
| `WHATSAPP_ACCESS_TOKEN` | REQUIRED-CONDITIONAL | `notify.js:18`, `critical-alert.js:65` | ✅ | ❌ | ✅ if `WHATSAPP_ENABLED=true` |
| `WHATSAPP_PHONE_NUMBER_ID` | REQUIRED-CONDITIONAL | `notify.js:18`, `critical-alert.js:64` | ✅ | ❌ | ✅ if `WHATSAPP_ENABLED=true` |
| `WHATSAPP_API_VERSION` | OPTIONAL | `notify.js:19` | ✅ | ❌ | ❌ (safe default) |
| `WHATSAPP_OTP_TEMPLATE_NAME` | OPTIONAL | `services/whatsapp_otp.js` | ✅ | ❌ | ❌ |
| `WHATSAPP_OTP_TEMPLATE_LANG` | OPTIONAL | `services/whatsapp_otp.js` | ✅ | ❌ | ❌ |
| `ADMIN_PHONE` | REQUIRED-PROD (alerts) | `critical-alert.js:11` | ✅ | ❌ | ⚠️ (warn-only — alerts degrade gracefully) |
| `TWILIO_*` (5 vars) | OPTIONAL | `routes/auth.js`, `routes/video.js` | ✅ | ❌ | ❌ (feature-flagged via VIDEO_CONSULTATION_ENABLED) |
| `VIDEO_CONSULTATION_ENABLED` | OPTIONAL | `routes/video.js` | ✅ | ❌ | ❌ |
| `R2_ENDPOINT` | REQUIRED-PROD | `storage.js:16,25,90` | **❌** | ❌ | ✅ add (sub-issue E) |
| `R2_ACCESS_KEY_ID` | REQUIRED-PROD | `storage.js:16,27,90` | **❌** | ❌ | ✅ add (sub-issue E) |
| `R2_SECRET_ACCESS_KEY` | REQUIRED-PROD | `storage.js:16,28,90` | **❌** | ❌ | ✅ add (sub-issue E) |
| `R2_BUCKET_NAME` | REQUIRED-PROD | `storage.js:16,32,90` | **❌** | ❌ | ✅ add (sub-issue E) |
| `OPS_AGENT_KEY` | OPTIONAL (Stage 1, Theme 3) | `routes/ops.js:148` | ❌ | ❌ | ❌ (Stage 2 cutover will require it; document now) |
| `OPS_USER` | OPTIONAL | `routes/ops.js` | ✅ | ❌ | ❌ (dev/staging /ops dashboard) |
| `OPS_PASS` | OPTIONAL | `routes/ops.js` | ✅ | ❌ | ❌ |
| `OPS_SSH_*` | OPTIONAL | `routes/ops.js` | ✅ | ❌ | ❌ |
| `BUSINESS_EMAIL` | OPTIONAL | `server.js:496` | ✅ | ❌ | ❌ (safe default) |
| `BUSINESS_PHONE` | OPTIONAL | `server.js:497` | ✅ | ❌ | ❌ |
| `BUSINESS_ADDRESS` | OPTIONAL | `server.js:498` | ✅ | ❌ | ❌ |
| `PRICE_RANGE_MIN` / `MAX` | OPTIONAL | `server.js:502,503` | ✅ | ❌ | ❌ |
| `BRAND_NAME` | OPTIONAL | `middleware.js:227`, several routes | ❌ | ❌ | ❌ (safe default "Tashkheesa") |
| `LANG_COOKIE_NAME` | OPTIONAL | `middleware.js:223` | ❌ | ❌ | ❌ |
| `LAUNCH_DATE` | OPTIONAL | `routes/pages.js:75` | ✅ | ❌ | ❌ |
| Cloudinary, Instagram/Meta, FB | OPTIONAL | `routes/pages.js` | ✅ | ❌ | ❌ (Instagram feed feature, not launch-critical) |
| `PORT` | OPTIONAL | `notification_worker.js:98` | ✅ | ❌ | ❌ (safe default 3000) |

**Vars in code, missing from `.env.example` (silent dependencies):**
1. `RESEND_API_KEY` (sub-issue A) — primary email transport.
2. `SESSION_SECRET` (sub-issue C) — JWT_SECRET fallback (recommendation: kill in code, not document).
3. `PAYMOB_LIVE_PAYMENTS` (sub-issue B) — recommendation: kill in code, not document.
4. `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME` (sub-issue E) — file storage.
5. `OPS_AGENT_KEY` (Theme 3 Stage 1, optional) — should be documented in advance of Stage 2 cutover.
6. `BRAND_NAME`, `LANG_COOKIE_NAME` — minor; safe defaults exist.

**Vars in `.env.example`, never read by code (dead docs):**
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS` — all 5 dead since
  the 2026-04-30 Resend migration. `SMTP_FROM_EMAIL` and `SMTP_FROM_NAME` are reused
  by Resend but the variable names are misleading.

### Sub-issue E — R2 (Cloudflare object storage) vars

**Reads in code:** All four (`R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
`R2_BUCKET_NAME`) read at module-load in `src/storage.js:16,25–32`. The module
declares them in a `REQUIRED_ENV_VARS` array and `console.warn`s on miss but **does not
throw**. The `S3Client` is instantiated regardless; failure happens later inside
`putObject` / `getSignedUrl` calls.

```javascript
// src/storage.js:16-21
const REQUIRED_ENV_VARS = ['R2_ENDPOINT', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME'];
const missingEnv = REQUIRED_ENV_VARS.filter(function(k) { return !process.env[k]; });
if (missingEnv.length > 0) {
  console.warn('[R2] Missing env vars: ' + missingEnv.join(', ') + ' — uploads/downloads will fail until set in Render.');
}
```

**Features depending on R2 (verified via grep):**
- Patient case file uploads (`routes/order_flow.js:74`)
- Doctor profile photos (`routes/doctor.js:2651,2767`)
- Prescription PDFs (`routes/prescriptions.js:142`)
- Generic file download (`server.js:407–415` → `storage.getSignedDownloadUrl`)

**Launch criticality: REQUIRED.** The patient new-case wizard uploads medical
photos / lab results to R2; the doctor case view downloads them via signed URLs.
With any R2_* var missing, every download surfaces as 500 "File temporarily
unavailable" (catch block at `server.js:418`) — patient cannot view their own
prescription, doctor cannot read intake.

**`.env.example` coverage:** All four absent. Lines 102–104 document
`UPLOADCARE_PUBLIC_KEY` / `UPLOADCARE_SECRET_KEY`; the section header reads
"File Storage (Uploadcare)". (Uploadcare is used for doctor profile photos during
signup at `routes/auth.js:825`; R2 is used for case files. The two coexist for now.)

**Boot validator coverage:** none.

**Scope judgment:** Fits inside Theme 4. Two files touched
(`.env.example` + `bootCheck.js`); no logic changes. Sub-issue E2 split is unnecessary.

---

## 3. Root Cause

The Tashkheesa portal grew through three discrete migrations in 2026:
1. SQLite → Postgres (Theme 1, schema drift).
2. Local disk → Cloudflare R2 file storage (date unclear from git, predates the audit).
3. Gmail SMTP / nodemailer → Resend HTTP API (2026-04-30, per `emailService.js:15`).

Each migration left footprints in `.env.example` and the boot validator that
weren't reconciled with the new code: SMTP vars stayed documented, R2 vars never
got documented, `RESEND_API_KEY` was added to code but not to docs or to the
validator. Theme 5 patched `DATABASE_URL_DIRECT` (added in `job_queue.js` for
fail-fast and in `.env.example` for documentation) using the right pattern —
fail-fast at module-load with a fall-through to dev — but didn't generalise that
pattern to the rest of the env-var surface.

`PAYMOB_LIVE_PAYMENTS` is a different artefact: it was added during early Paymob
integration as a UI-only kill-switch, before `services/paymob.js` was hardened
with `_assertTestMode()`. The two flags coexist with no synchronisation; the
contradiction is real but currently inactive because the UI flag is unset.

`SESSION_SECRET` in `requireJWT.js` is a defensive carry-over — likely added
when the `/api/v1/*` mobile routes were extracted into their own middleware,
under the assumption that some other module might already be reading
`SESSION_SECRET`. None do. The fallback is dead in practice (the `server.js`
IIFE blocks it) but it's a code smell that should be cleaned up.

The **systemic** root cause is that env-var changes don't route through a
single source of truth. `.env.example` is hand-edited; the validator is
hand-edited; production env vars on Render are dashboard-edited. None of the
three are linted against each other.

---

## 4. Fix Plan

Each sub-issue lands as a separate atomic commit; a sixth commit adds the lint
test (Section 6). All diffs touch at most three files — no schema, no business
logic, no dependency changes. Pattern matches Theme 5's
`DATABASE_URL_DIRECT` rollout (fail-fast at module-load + `.env.example`
update + lint test).

### Sub-issue A — Document `RESEND_API_KEY`, kill SMTP dead doc, add to validator

**Files:** `.env.example`, `src/server.js` (extend the IIFE).

**`.env.example` — replace lines 106–114 (entire SMTP block):**
```diff
-# ── Email (SMTP) ──────────────────────────────────────────────────────────────
-EMAIL_ENABLED=true
-SMTP_HOST=smtp.zoho.com
-SMTP_PORT=465
-SMTP_SECURE=true
-SMTP_USER=noreply@tashkheesa.com
-SMTP_PASS=
-SMTP_FROM_EMAIL=noreply@tashkheesa.com
-SMTP_FROM_NAME=Tashkheesa
+# ── Email (Resend HTTP API) ───────────────────────────────────────────────────
+# Migrated from Gmail SMTP / nodemailer on 2026-04-30. Resend is the only
+# transport. RESEND_API_KEY is REQUIRED for all transactional email — case
+# lifecycle notifications, password reset, payment receipts. Without it,
+# templated email throws fatally and lifecycle notifications silently stub.
+# Get the key from: https://resend.com → API Keys.
+RESEND_API_KEY=
+EMAIL_ENABLED=true
+# Sender identity (legacy variable names kept for compatibility):
+SMTP_FROM_EMAIL=noreply@tashkheesa.com
+SMTP_FROM_NAME=Tashkheesa
```

**`src/server.js:51–68` — extend the IIFE:**
```diff
 (function validateCriticalEnvVars() {
-  var required = ['JWT_SECRET', 'DATABASE_URL', 'ANTHROPIC_API_KEY'];
+  var required = ['JWT_SECRET', 'DATABASE_URL', 'ANTHROPIC_API_KEY', 'RESEND_API_KEY', 'NATIONAL_ID_ENCRYPTION_KEY'];
   var missing = [];
```

Note the IIFE today is unconditional — it always exits on miss. To preserve
local-dev ergonomics for `RESEND_API_KEY` and `NATIONAL_ID_ENCRYPTION_KEY` (a fresh
clone shouldn't need them), gate strictness on `MODE`:
```diff
+  var devOnly = ['RESEND_API_KEY', 'NATIONAL_ID_ENCRYPTION_KEY'];
+  var mode = String(process.env.MODE || process.env.NODE_ENV || 'development').toLowerCase();
   required.forEach(function(varName) {
     var value = process.env[varName];
     if (!value || String(value).trim() === '') {
+      if (devOnly.indexOf(varName) !== -1 && mode === 'development') {
+        console.warn('⚠️  ' + varName + ' missing — degraded mode (development only)');
+        return;
+      }
       missing.push(varName);
     }
   });
```

### Sub-issue B — Kill `PAYMOB_LIVE_PAYMENTS`, document the test-only contract

**Files:** `src/routes/patient.js`, `.env.example`.

**`src/routes/patient.js:1332` — drop the unused EJS context flag:**
```diff
-      paymobLiveMode: String(process.env.PAYMOB_LIVE_PAYMENTS || '').trim().toLowerCase() === 'true',
```
Then audit `src/views/patient_new_case.ejs:710` and remove the `__liveMode` branch
(it always evaluates to `false` once the flag is gone — confirm no other consumer).

**`src/routes/patient.js:1690–1710` — replace the env-flag branch with a single
test-mode-aware path:** the current "stub success" path is intentional during
test-mode launches and remains the canonical path until live payments are
enabled by an explicit code change. Replace:
```diff
-  const liveMode = String(process.env.PAYMOB_LIVE_PAYMENTS || '').trim().toLowerCase() === 'true';
-  if (!liveMode) {
-    return res.redirect('/portal/patient/orders/' + encodeURIComponent(orderId) + '/payment-success?stub=1');
-  }
-  try {
-    const { getOrCreatePaymentUrl } = require('./payments');
-    const url = await getOrCreatePaymentUrl(owned);
-    return res.redirect(url || '/dashboard');
-  } catch (e) {
-    console.error('[wizard step5 live] payment-url resolve failed', e && e.message ? e.message : e);
-    return res.redirect('/patient/new-case?step=5&id=' + encodeURIComponent(orderId) + '&failed=1');
-  }
+  // Paymob currently runs in test mode (PAYMOB_MODE=test, hard-gated in
+  // services/paymob.js). The wizard short-circuits to a stub success route
+  // that calls markCasePaid() server-side — this is the launch path until a
+  // future change unlocks PAYMOB_MODE=live in services/paymob.js.
+  return res.redirect('/portal/patient/orders/' + encodeURIComponent(orderId) + '/payment-success?stub=1');
```
Same edit at `patient.js:1773` (the `payment-success` GET handler — the
`?stub=1` branch becomes the only branch).

**`.env.example`** — leave `PAYMOB_MODE=test` as the documented value, with
clarifying comment:
```diff
-PAYMOB_MODE=test                        # test | live (live not permitted in code yet)
+PAYMOB_MODE=test                        # test ONLY. Live mode requires editing
+                                        # services/paymob.js (_assertTestMode) and
+                                        # routes/patient.js (re-enabling the live
+                                        # branch). Don't set this to "live" without
+                                        # those code changes — services/paymob.js
+                                        # will throw PAYMOB_MODE_NOT_TEST.
```

**Alternate (heavier, not recommended for launch):** Wire `PAYMOB_MODE` end-to-end
— make `paymob.js` honour `live` mode, expose mode via the wizard EJS context,
keep `PAYMOB_LIVE_PAYMENTS` removed. Defer to post-launch.

### Sub-issue C — Remove the `SESSION_SECRET` fallback

**File:** `src/middleware/requireJWT.js`.

```diff
-const JWT_SECRET = process.env.JWT_SECRET || process.env.SESSION_SECRET;
+const JWT_SECRET = process.env.JWT_SECRET;
 if (!JWT_SECRET) throw new Error('FATAL: JWT_SECRET environment variable is not set');
```

This aligns `requireJWT.js` with `auth.js:39,46` and `routes/ops.js:114` which
all read `JWT_SECRET` directly. The `server.js:51–68` IIFE continues to be the
canonical boot guard.

`.env.example` does not need updating — `SESSION_SECRET` was never documented;
removing the fallback simply matches docs to behaviour.

### Sub-issue D — Centralise per-module fail-fast + add the gaps

**File:** `src/server.js` (extend the IIFE).

```diff
 (function validateCriticalEnvVars() {
-  var required = ['JWT_SECRET', 'DATABASE_URL', 'ANTHROPIC_API_KEY'];
+  var required = [
+    'JWT_SECRET',
+    'DATABASE_URL',
+    'ANTHROPIC_API_KEY',
+    'RESEND_API_KEY',
+    'NATIONAL_ID_ENCRYPTION_KEY',
+    'PAYMOB_PUBLIC_KEY',
+    'PAYMOB_SECRET_KEY',
+    'PAYMOB_HMAC_SECRET',
+    'PAYMOB_CARD_INTEGRATION_ID',
+    'PAYMOB_NOTIFICATION_URL',
+    'PAYMOB_MODE',
+    'TASH_API_KEY',
+    'PUBLIC_ORDER_API_KEY',
+    'UNSUBSCRIBE_SECRET',
+    'BASE_URL',
+    'APP_URL',
+    'UPLOADCARE_PUBLIC_KEY',
+    'UPLOADCARE_SECRET_KEY',
+  ];
+  // Vars that are fatal in staging/production but warn-only in development
+  // (so a fresh clone can boot and run unit tests without secrets).
+  var prodOnly = [
+    'RESEND_API_KEY',
+    'NATIONAL_ID_ENCRYPTION_KEY',
+    'PAYMOB_PUBLIC_KEY', 'PAYMOB_SECRET_KEY', 'PAYMOB_HMAC_SECRET',
+    'PAYMOB_CARD_INTEGRATION_ID', 'PAYMOB_NOTIFICATION_URL', 'PAYMOB_MODE',
+    'TASH_API_KEY', 'PUBLIC_ORDER_API_KEY', 'UNSUBSCRIBE_SECRET',
+    'BASE_URL', 'APP_URL',
+    'UPLOADCARE_PUBLIC_KEY', 'UPLOADCARE_SECRET_KEY',
+  ];
+  var mode = String(process.env.MODE || process.env.NODE_ENV || 'development').toLowerCase();
   var missing = [];
   required.forEach(function(varName) {
     var value = process.env[varName];
     if (!value || String(value).trim() === '') {
+      if (prodOnly.indexOf(varName) !== -1 && mode === 'development') {
+        console.warn('⚠️  ' + varName + ' missing — degraded mode (development only)');
+        return;
+      }
       missing.push(varName);
     }
   });
```

Then **delete** the per-module fail-fasts that are now redundant — `routes/campaigns.js:14–22`
(`UNSUBSCRIBE_SECRET`) and `routes/tash-api.js:6–13` (`TASH_API_KEY`) — keeping the
runtime checks but removing the module-load `throw` since the IIFE catches missing
vars earlier and with better diagnostics.

`OPS_AGENT_KEY` is **not** added to the validator (Stage 1 is intentionally
optional per Theme 3). Document it in `.env.example` so deployers can
plan for Stage 2:
```diff
+# Theme 3 Stage 1 (optional). If set, /ops/agent/* routes log "agent <route>
+# signed OK" when the X-Ops-Agent-Key header matches; otherwise log
+# "agent <route> unsigned" but do not reject. Stage 2 cutover (after one full
+# uptime cycle with signing on) flips to mandatory. See
+# docs/runbooks/THEME_03_OPS_AGENT_KEY_CUTOVER.md.
+OPS_AGENT_KEY=
```

### Sub-issue E — Document and validate R2

**Files:** `.env.example`, `src/storage.js`.

**`.env.example`** — replace the "File Storage (Uploadcare)" section header with two
clearly-scoped subsections:
```diff
-# ── File Storage (Uploadcare) ────────────────────────────────────────────────
+# ── File Storage: Uploadcare (doctor profile photos during signup) ───────────
 UPLOADCARE_PUBLIC_KEY=
 UPLOADCARE_SECRET_KEY=
+
+# ── File Storage: Cloudflare R2 (case files, prescriptions, intake) ──────────
+# REQUIRED in production. Patient medical photos, prescription PDFs, and
+# intake forms all live in R2; doctors download via signed URLs. Get keys
+# from: Cloudflare → R2 → Manage R2 API Tokens → Create token (admin r/w on
+# the bucket). The endpoint is the "S3 API endpoint" shown on the bucket
+# overview (looks like https://<account>.r2.cloudflarestorage.com).
+R2_ENDPOINT=
+R2_ACCESS_KEY_ID=
+R2_SECRET_ACCESS_KEY=
+R2_BUCKET_NAME=
```

**`src/storage.js:16–21` — promote the warn to a fail-fast in non-dev:**
```diff
 const REQUIRED_ENV_VARS = ['R2_ENDPOINT', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME'];
 const missingEnv = REQUIRED_ENV_VARS.filter(function(k) { return !process.env[k]; });
-if (missingEnv.length > 0) {
-  console.warn('[R2] Missing env vars: ' + missingEnv.join(', ') + ' — uploads/downloads will fail until set in Render.');
-}
+if (missingEnv.length > 0) {
+  var mode = String(process.env.MODE || process.env.NODE_ENV || 'development').toLowerCase();
+  if (mode === 'development') {
+    console.warn('[R2] Missing env vars: ' + missingEnv.join(', ') + ' — uploads/downloads will fail until set (dev warning).');
+  } else {
+    throw new Error('[R2] FATAL: missing env vars: ' + missingEnv.join(', ') + '. ' +
+      'Patient case files and prescriptions cannot be served. Set on Render → Environment.');
+  }
+}
```

This matches the Theme 5 `DATABASE_URL_DIRECT` pattern (fatal in non-dev, warn in
dev). It prefers a module-load throw over the centralised IIFE because R2 has
four interdependent vars where partial configuration is itself a bug — the
all-or-nothing assertion belongs next to the S3 client init.

---

## 5. Verification Steps

How we prove the fail-fast fires correctly:

1. **Unset `RESEND_API_KEY` locally with `MODE=production`** and start the server:
   ```bash
   MODE=production unset RESEND_API_KEY && node src/server.js
   ```
   Expect: stderr contains `FATAL: Missing required environment variables: RESEND_API_KEY`,
   exit code 1, no HTTP listener bound.

2. **Same for each newly-validated var.** Loop:
   ```bash
   for v in RESEND_API_KEY NATIONAL_ID_ENCRYPTION_KEY PAYMOB_PUBLIC_KEY PAYMOB_SECRET_KEY \
            PAYMOB_HMAC_SECRET PAYMOB_CARD_INTEGRATION_ID PAYMOB_NOTIFICATION_URL \
            PAYMOB_MODE TASH_API_KEY PUBLIC_ORDER_API_KEY UNSUBSCRIBE_SECRET \
            BASE_URL APP_URL UPLOADCARE_PUBLIC_KEY UPLOADCARE_SECRET_KEY \
            R2_ENDPOINT R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET_NAME; do
     echo "--- Testing $v missing ---"
     env -u $v MODE=production node src/server.js 2>&1 | grep -E "(FATAL|ALERT|Boot)" | head -5
   done
   ```
   Expect: each iteration prints a fatal line referencing the unset var.

3. **`PAYMOB_LIVE_PAYMENTS` is dead.** After Sub-issue B lands:
   ```bash
   grep -rn "PAYMOB_LIVE_PAYMENTS" src/ public/ scripts/
   ```
   Expect: zero matches.

4. **`SESSION_SECRET` fallback is dead.** After Sub-issue C lands:
   ```bash
   grep -rn "SESSION_SECRET" src/
   ```
   Expect: zero matches.

5. **R2 dev-fallback still works.** With `MODE=development` and all four R2_*
   unset: server should log a warn line and start. Hitting `/files/<id>` should
   return 500 from inside the handler (existing behaviour), not crash boot.

How we prove dev still boots without production-only vars:

6. **Fresh-clone simulation:**
   ```bash
   cp .env.example .env.test && \
   sed -i.bak 's/^MODE=.*/MODE=development/' .env.test && \
   env $(cat .env.test | grep -v '^#' | xargs) node src/server.js
   ```
   Expect: warns on missing RESEND/PAYMOB/etc. but does NOT exit; HTTP listener
   binds to port 3000.

How we prove production currently passes:

7. **Render boot logs** after the deploy: `MODE=production` should print
   `All required env vars present: <comma-list>` from the IIFE's `logVerbose`
   path. Any `FATAL: Missing required environment variables:` line in deploy
   logs is a launch-blocker.

---

## 6. What to Add to the Test Suite

Two lint tests, modelled on Theme 1's `tests/core/no-mobile-api-boot-script.test.js`:

**T1: every var read by the code is documented in `.env.example`.**

`tests/core/env-coverage.test.js`:
```javascript
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Walk src/ + app.js, grep for process.env.X, dedupe.
const out = execSync('grep -rhoE "process\\.env\\.[A-Z_][A-Z0-9_]+" src/ app.js', { encoding: 'utf8' });
const fromCode = new Set(out.split('\n').filter(Boolean).map(s => s.replace('process.env.', '')));

// Allowlist: build-time injected, test/script-only, and intentionally-undocumented.
const ALLOWED_UNDOCUMENTED = new Set([
  'RENDER_GIT_COMMIT', 'RENDER_COMMIT', 'RENDER_SERVICE_NAME', 'GIT_SHA', 'COMMIT_SHA',
  'NODE_ENV', // covered by MODE
  'BRAND_NAME', 'LANG_COOKIE_NAME', // safe defaults
  'PORTAL_DB_PATH', 'DB_PATH', 'SQLITE_PATH', // legacy migration scripts
  'STAGING_USER', 'STAGING_PASS', // legacy basic-auth aliases
  // ... (curated list, kept short)
]);

const example = fs.readFileSync(path.join(__dirname, '../../.env.example'), 'utf8');
const inExample = (v) => new RegExp(`^\\s*#?\\s*${v}\\s*=`, 'm').test(example);

const missing = [...fromCode].filter(v => !inExample(v) && !ALLOWED_UNDOCUMENTED.has(v));

test('every env var read by code is documented in .env.example', () => {
  expect(missing).toEqual([]);
});
```

**T2: every var documented in `.env.example` is read by code, OR explicitly grandfathered.**

Same shape, reverse direction. Catches the next dead-doc regression (e.g. someone
adding a new third-party integration that gets removed mid-flight).

**T3 (optional, lighter): boot validator covers REQUIRED-PROD vars.**

Static assertion that the `required` array in `validateCriticalEnvVars` contains
the canonical list. Catches the case where someone adds a new REQUIRED-PROD var
to code without remembering the validator.
```javascript
test('boot validator covers all REQUIRED-PROD vars', () => {
  const server = fs.readFileSync('src/server.js', 'utf8');
  const REQUIRED_PROD = [
    'JWT_SECRET', 'DATABASE_URL', 'ANTHROPIC_API_KEY', 'RESEND_API_KEY',
    'NATIONAL_ID_ENCRYPTION_KEY', 'PAYMOB_PUBLIC_KEY', /* ... */
  ];
  REQUIRED_PROD.forEach(v => {
    expect(server).toMatch(new RegExp(`'${v}'`));
  });
});
```

Add all three to `package.json` `npm test` and to the existing CI/Render
pre-deploy gate.

---

## 7. Rollback Plan

Each sub-issue is one commit (sub-issue A, B, C, D, E + lint test = 6 commits).

| Sub-issue | Files touched | Rollback | Caveat |
|---|---|---|---|
| A | `.env.example`, `src/server.js` | `git revert <sha>` | If the deploy boots and email starts erroring, set `RESEND_API_KEY` on Render and redeploy with the revert. |
| B | `src/routes/patient.js`, `src/views/patient_new_case.ejs`, `.env.example` | `git revert <sha>` | UI returns to the unused-flag state; no behavioural change at the wizard since the flag was unset on Render. |
| C | `src/middleware/requireJWT.js` | `git revert <sha>` | Restores the dead fallback. Zero runtime impact unless the IIFE is also broken. |
| D | `src/server.js`, `src/routes/campaigns.js`, `src/routes/tash-api.js` | `git revert <sha>` | The per-module fail-fasts removed in this commit are restored. Production safe. |
| E | `.env.example`, `src/storage.js` | `git revert <sha>` | If the new module-load throw fires unexpectedly in prod, revert to restore the warn-only behaviour. **Caveat:** if any R2 env var was newly set on Render in advance of the deploy, leave it set; the revert keeps the code warn-only. |
| Lint tests | `tests/core/env-coverage.test.js` | `git revert <sha>` | Only catches future regressions; reverting weakens the safety net but does not affect runtime. |

If multiple commits need to be reverted, prefer a single `git revert <oldest>..<newest>`
in chronological order so the dependency graph stays consistent.

---

## 8. Open Questions for Ziad

### OQ-1: Which currently-missing vars are genuinely REQUIRED-PROD vs DOCUMENTED-OPTIONAL?

The audit's "14+ production-required vars" framing assumes every var read by
code is required. The table in §2 sub-issue D classifies my read; some entries
are judgement calls:

- **`BASE_URL` and `APP_URL`** — used by email templates and JSON-LD schema. If
  unset, email links 404 and structured data is missing. Are these "must boot
  with these set" or "warn and continue"? *My recommendation: REQUIRED-PROD,
  fail-fast. Email and SEO are launch-critical.*
- **`UPLOADCARE_PUBLIC_KEY` / `UPLOADCARE_SECRET_KEY`** — used during doctor
  profile-photo upload at signup. If unset, doctor signup wizard's photo step
  silently fails. Doctor can complete signup without a photo. *Recommendation:
  REQUIRED-PROD if doctor-signup-with-photo is launch-day live; OPTIONAL
  otherwise. Need confirmation.*
- **`ADMIN_PHONE`** — alert recipient for crash WhatsApp messages. If unset,
  alerts silently no-op. Currently the audit doesn't flag this as P0; my read
  is warn-only. *Confirm: do you want a hard-fail if `ADMIN_PHONE` is unset in
  production, or warn-and-continue?*

### OQ-2: PAYMOB_LIVE_PAYMENTS — fix it or kill it?

Recommended path: **kill it now** (Sub-issue B as written). The flag is
inconsistent with `services/paymob.js`'s hard-throw and with `PAYMOB_MODE`. Live
payments will need a deliberate code change anyway (remove `_assertTestMode()`,
update `services/paymob.js` to honour `PAYMOB_MODE=live`, update wizard EJS to
read mode dynamically), and that's not a config flag — it's a release.

The alternative — wire `PAYMOB_LIVE_PAYMENTS` into `paymob.js` so the flag
*actually* flips live mode — is a larger change, requires Paymob production
credentials to test against, and arguably belongs in a separate "Paymob go-live"
phase post-launch. Confirm: do you want Sub-issue B to kill the flag (current
plan) or to wire it through?

### OQ-3: Should `OPS_AGENT_KEY` be promoted to REQUIRED in the validator now?

Theme 3's plan was Stage 1 = optional, Stage 2 = required, with a soak period.
If you've already completed Stage 1 (signing-on-but-not-enforced) and the
`docs/runbooks/THEME_03_OPS_AGENT_KEY_CUTOVER.md` runbook says we're past the
soak period, Sub-issue D should add it. If not, leave it warn-only and
document as proposed.

### OQ-4: SMTP_FROM_EMAIL / SMTP_FROM_NAME naming

Resend reads these to set the "from" address. The variable names date from
the Gmail SMTP era and are misleading. Two options:
- **Keep as-is** (Sub-issue A as written): annotate `.env.example` to clarify
  they're Resend sender identity, not SMTP transport.
- **Rename to `EMAIL_FROM_ADDRESS` / `EMAIL_FROM_NAME`**: cleaner, requires a
  three-place edit (`emailService.js:86–87`, `routes/static-pages.js:224`,
  `.env.example`) and a Render dashboard update. Does not block launch.

*Recommendation: keep as-is for Theme 4; rename in a follow-up cleanup if
desired. Confirm.*

### OQ-5: `SESSION_SECRET` — confirm it's not set on Render

The fix in Sub-issue C is safe even if `SESSION_SECRET` is currently set on
Render, because the fallback only kicks in when `JWT_SECRET` is empty (which
the IIFE blocks). But for completeness: is `SESSION_SECRET` set on Render
production today? If yes, leave the dashboard value untouched after the code
ships (it'll be ignored); if no, also delete the placeholder if any.

### OQ-6: Should `.env.production` be cleaned up?

`.env.production` currently contains a single line — `DATABASE_URL=...` — with
a real credential committed to git history. This is outside Theme 4's scope
but worth a P3 follow-up: that file should not be in the repo if it contains
production credentials, even if `.gitignore` ignores future writes. Flag for a
separate security cleanup.

---

## Appendix: discovered-but-deferred items

Logged here so they can be fixed outside Theme 4 without losing the trail:

- **`P3-ENV-1` — `.env.production` contains a committed `DATABASE_URL` with embedded
  credentials.** See OQ-6. Recommend a separate audit to scrub git history and
  rotate the credential.
- **`P3-ENV-2` — `tash-api.js:7` defines `TASH_API_KEY_DEFAULT = 'tash-default-key-change-me'`
  and uses it as a sentinel.** The pattern is correct (rejects explicitly), but the
  literal default string in source is a code smell. Cleanup: move the sentinel
  check into the central validator and remove the literal.
- **`P3-ENV-3` — `routes/campaigns.js:22` keeps an in-process fallback secret
  `'tash-unsub-dev-only'` for unsubscribe tokens.** Dev-only path; warn-and-continue.
  Sub-issue D centralisation will make this redundant; the dev fallback can be
  removed in a follow-up.
- **`P3-ENV-4` — `BRAND_NAME` is read by `middleware.js:227`, `routes/auth.js:710`,
  `routes/prescriptions.js:544`, `routes/doctor.js:115` but absent from
  `.env.example`.** Has a safe default of "Tashkheesa" so not launch-blocking;
  document for completeness in the Sub-issue D commit if convenient.
- **`P3-ENV-5` — Many SLA tuning vars (`SLA_AUTO_PAUSE_*`, `SLA_REMINDER_MINUTES`)
  are documented but not validated.** All have safe defaults; tuning-only. Consider
  a range-validator pass once the perf-tuning picture stabilises post-launch.
- **`P3-UPLOAD-1` — Stale `?error=missing` flash redirect on empty-upload submit.**
  Discovered during Phase 4 Uploadcare verification. `src/routes/patient.js:2891`
  still emits `res.redirect('/portal/patient/orders/${orderId}/upload?error=missing')`
  when the POST upload handler receives no URLs (e.g. patient submitted with the
  Uploadcare widget empty). The standalone uploader was retired on 2026-05-06
  (commit 742b464), so the new GET handler at `patient.js:2836` immediately
  bounces this redirect to the wizard (DRAFT) or order detail page (non-DRAFT) —
  the patient never lands on a broken page. But the URL bar momentarily flashes
  `?error=missing` during the bounce, and the actual error reason (no file
  attached) is silently dropped instead of being surfaced to the user. *Symptom
  reported by Ziad on 2026-05-08.* **Fix sketch:** change the empty-urls branch
  at `patient.js:2891` (and the sibling redirects at `:2875`, `:2889`, `:2901`,
  `:2905`, `:2966`) to point directly at the wizard or order-detail page,
  carrying the error code as a query param the destination view actually reads
  (the wizard reads `?err=`, not `?error=`). Map the redirect target on
  `isCanonStatus(order.status, 'DRAFT')` like the GET handler does. **Not a
  launch blocker** — the patient ends up on a working page either way.
  **Scope:** ~6 redirect-line edits, no logic change.
