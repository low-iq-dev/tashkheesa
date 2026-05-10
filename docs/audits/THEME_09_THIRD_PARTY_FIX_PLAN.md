# Theme 9 — Third-Party Silent Degradation: Fix Plan

**Status:** Scoping only. No code changes in this commit.
**Reference:** `docs/audits/COMPREHENSIVE_PRE_LAUNCH_AUDIT_2026-05-06.md`
**Sister themes:** Theme 1 (schema drift), Theme 3 (CSRF), Theme 4 (env vars), Theme 5 (pool saturation), Theme 7 (state machine), Theme 10 (i18n).
**Scope:** Five named third-party silent-degradation findings (WhatsApp 401, critical-alert.js, video flag, Anthropic models, Instagram token) plus a cross-cutting integration-resilience pass. Sub-issue F sweeps the remaining integration surface for new findings worth logging.

---

## 1. Executive Summary

Tashkheesa wires nine third-party integrations directly into user-facing flows
(payments, notifications, file storage, AI extraction, video calls, social
publishing). The audit's top-line claim — *every one of these can fail silently*
— is largely confirmed. This plan classifies each named sub-issue, separates
**code-fixable now** from **blocked on external work**, and proposes the smallest
diff that closes the alerting gap without touching business logic.

The pattern across all five sub-issues is identical: **the integration logs the
failure to `error_logs` (or worse, to console only) and returns a soft `{ok:
false}`. No alert path fires. No degradation switch trips.** Operators only
discover the failure when a patient phones in. Because the most-broken integration
is the one that delivers the alerts (WhatsApp critical-alert), the system is
self-blinding: WhatsApp dies → critical-alert tries to alert via WhatsApp →
critical-alert silently dies → operator never hears about either.

Three of the five sub-issues are **fully code-fixable inside this theme** (B, C, D).
Sub-issue A is *partially* fixable: the alerting plumbing can land now, but the
real cure (token rotation hygiene + Meta-template paths) waits on Meta verification
which Ziad is mid-process on. Sub-issue E is fully code-fixable but is the lowest
priority — Instagram posting is marketing automation, not patient-facing.

Sub-issue F surfaces three new P3 entries (`P3-INTEG-1` through `P3-INTEG-3`)
discovered while sweeping the integration list. None block launch; logged for
the trail.

**Overall recommendation:** Land Sub-issues B + C + D in this theme (small,
self-contained, no external dependencies). Land the alerting half of A (the
periodic "WA-401 in last 15 min" job). Defer the WhatsApp template rewrite
half of A and Sub-issue E to follow-up themes once Meta verification clears.

---

## 2. Current State

### Integration call-graph (verified at file open)

| Integration | Client module | Failure-write target | Alert path? | Fallback? |
|---|---|---|---|---|
| WhatsApp Cloud API (template) | `src/notify/whatsapp.js` | `error_logs.category='whatsapp_send'` | none — see Sub-issue A | none |
| WhatsApp Cloud API (alert) | `src/critical-alert.js` | none (errors swallowed) | self — see Sub-issue B | none |
| Twilio Video | `src/video_helpers.js` | thrown to caller | console only | none — see Sub-issue C |
| Twilio Verify (OTP) | `src/services/twilio_verify.js` | console + DB stub fallback | none | DB-stored OTP |
| Anthropic Claude | 4 distinct call sites — see Sub-issue D | `case_files.processing_error` (one of four) | none | none |
| Instagram Graph API | `src/instagram/client.js` | `ig_scheduled_posts.error_message` | none — see Sub-issue E | none |
| Resend (email) | `src/services/emailService.js` | `error_logs.category='email_send'` | none | none |
| Paymob | `src/services/paymob.js`, `src/routes/payments.js` | `payment_events` table | partial — see §F | none |
| Cloudflare R2 | `src/storage.js` | console only | none | none |
| Uploadcare | (widget-side, no server client) | n/a | n/a | n/a |
| Cloudinary | `src/instagram/image_generator.js` | thrown to caller | none | none |

### Sub-issue A — WhatsApp 401 silent

**Client surfaces:**

| File | Lines | Role |
|---|---|---|
| `src/notify/whatsapp.js` | 1–168 | Template-message client (the user-facing path: OTP, lifecycle notifications). Reads envs at module-load (lines 5–11) but **also** re-reads inside the function via destructuring at lines 70–72, so token rotation *would* work after a restart. |
| `src/critical-alert.js` | 1–60 | Alert-only client (raw text, admin phone). Captures envs at module load, never re-reads. See Sub-issue B. |

**Call sites of `sendWhatsApp` (template path):**

| File | Lines | Purpose |
|---|---|---|
| `src/notification_worker.js` | 6, 190 | Lifecycle notifications (case received, paid, doctor accepted, etc.) |
| `src/notify.js` | 5, 324 | Channel dispatcher |
| `src/services/whatsapp_otp.js` | 30, 77 | Mobile login OTP (legacy `sendOtpViaWhatsApp` shape) |
| `src/routes/doctor.js` | 29–30 | Doctor dashboard lifecycle helpers (uncommitted modification on local — not relevant here) |

**401 handling (verbatim, `whatsapp.js:135–150`):**
```javascript
if (!res.ok) {
  console.error('[WA] send failed', {
    status: res.status,
    statusText: res.statusText,
    url,
    response: data
  });
  logWhatsAppError({
    message: 'wa_meta_api_error',
    to: normalizedTo, template, lang,
    status: res.status,
    error: data && data.error ? data.error : data
  });
  return { ok: false, error: data, status: res.status };
}
```

`logWhatsAppError` writes to `error_logs` with `category='whatsapp_send'`, `level='error'`,
`message='wa_meta_api_error'`, and the Meta error payload in `context.error`. Schema
per migration 035; UUID/random id.

**Visibility surfaces (verified by grep):**

| Surface | Evidence | Verdict |
|---|---|---|
| `/ops/errors` generic dashboard | `src/views/ops-errors.ejs:51–55` (level filter only) | ✅ Visible — but mixed with every other error category. No "show only WhatsApp 401s" filter. |
| `/ops/errors?level=error` | same | ⚠️ Visible if operator clicks through; no card on dashboard. |
| ops dashboard cards (`src/routes/ops.js:475–501`) | `paymobHealth` is computed; **no `whatsappHealth` analog** | ❌ No top-level WhatsApp health indicator. |
| Critical-alert (sendCriticalAlert) | not invoked from `whatsapp.js` 401 branch | ❌ Never fires on 401. |
| Render logs / `console.error` | `whatsapp.js:136` writes a structured `[WA] send failed` line | ⚠️ Ops-grepable but not paged. |
| `error_logs` row on Meta refresh | logged with `status: 401` | ✅ Persisted, but no consumer queries by `status`. |

**Failure mode confirmed:** when the Meta access token expires (~60 days for
system-user tokens, never refreshed in code), every `sendWhatsApp` call returns
`{ok: false, status: 401}` and writes a persisted error row, but **no human
gets paged**. The notification worker (`notification_worker.js:251–256`) marks
the row as failed and retries with backoff (30s → 120s → 480s) for up to 3 attempts,
then leaves the row in `failed`. The patient never receives the OTP / case-received /
SLA-reminder; the ops dashboard total-errors counter ticks up but doesn't
distinguish WhatsApp 401 from a transient 503.

**External-dependency status (per Ziad):** Meta Business verification is
in progress. Several pieces of the *full* fix (utility-template re-engagement,
ops alert via WhatsApp template) cannot land until verification clears.

### Sub-issue B — `critical-alert.js` itself broken

Two compounding bugs, both verified at file open (`src/critical-alert.js:1–60`).

**Bug 1: module-load env capture (lines 6–9):**
```javascript
var ADMIN_PHONE = (process.env.ADMIN_PHONE || '').replace(/[^0-9]/g, '');
var WHATSAPP_PHONE_NUMBER_ID = (process.env.WHATSAPP_PHONE_NUMBER_ID || '').trim();
var WHATSAPP_ACCESS_TOKEN = (process.env.WHATSAPP_ACCESS_TOKEN || '').trim();
var WHATSAPP_API_VERSION = (process.env.WHATSAPP_API_VERSION || 'v22.0').trim();
```
These are captured into module-level `var`s when the module first loads at
`src/server.js:298`. If ops rotates `WHATSAPP_ACCESS_TOKEN` in Render's env
panel without a full process restart, this module continues to use the old
token until the next deploy. In Render's hot-reload world this is operationally
fragile.

**Contrast:** `src/notify/whatsapp.js:70–72` re-reads its env on every call (although
also captures at module load on line 5–11; Node only evaluates module body once,
so the destructure at line 5 is the actual capture; the lines 70–72 reads are from
the same captured constants). **Both modules effectively capture at module load**
— but `notify/whatsapp.js` is the one being used everywhere except crash alerts,
and rotating it requires the same restart. So the audit's framing is more
precise: *both* WhatsApp modules need a restart to pick up a new token, but
critical-alert is the one path that *must* still work when other things are
breaking, so its capture-at-load is more dangerous.

**Bug 2: free-form `type:'text'` body (lines 30–35):**
```javascript
var body = JSON.stringify({
  messaging_product: 'whatsapp',
  to: ADMIN_PHONE,
  type: 'text',
  text: { body: text }
});
```

Per Meta's Cloud API rules, a business may only send free-form `type:'text'`
messages to a customer **inside the 24-hour customer-service window** —
i.e., the customer messaged the business in the last 24 hours. Outside that
window, businesses must use a pre-approved template (utility / authentication /
marketing category). For the admin phone (which has presumably never replied to
a Tashkheesa-business outbound message), Meta returns error code 131047 ("Message
failed to send because more than 24 hours have passed since the recipient last
replied") with HTTP 4xx.

**The error is then silently dropped (lines 53–57):**
```javascript
req.on('error', function() {});       // line 53 — swallow network errors
req.on('timeout', function() { req.destroy(); });
req.write(body);
req.end();
} catch (_) {}                         // line 57 — swallow any throw
```
Plus `res.resume()` at line 50 drains the response body without inspecting
the status code. So even if Meta returns 4xx with a clear error, the alert
function returns void and lets the caller (`server.js:305,318`) believe the
alert was sent.

**Bug 3 (per audit, also confirmed): per-process throttle reset on every crash.**
`var lastSentAt = 0` at line 12 is module-scoped. The throttle "max 1 per 5
minutes" works for an `unhandledRejection` chain that doesn't kill the process,
but the flow at `server.js:309,322` is `setTimeout(process.exit(1), 500)` —
so every crash kills the process **after** sending the alert, the next process
starts with `lastSentAt = 0`, and a flapping crash loop sends one WhatsApp per
crash. Coupled with Bug 2, the spam either doesn't deliver (template error) or
will burn Meta rate limits if it ever does.

**Combined effect:** the most important alert path on the platform has been
non-functional since launch of the WhatsApp integration. Every prior
`unhandledRejection` is logged to `error_logs` (via `server.js:303`) and
console — but the WhatsApp ping has been silently swallowed.

### Sub-issue C — Video bookable + chargeable when `VIDEO_CONSULTATION_ENABLED=false`

**Flag definition (`src/video_helpers.js:11–37`):**
```javascript
const VIDEO_ENABLED = String(process.env.VIDEO_CONSULTATION_ENABLED || 'false') === 'true';
// ...
function isVideoEnabled() {
  return VIDEO_ENABLED && Boolean(ACCOUNT_SID) && Boolean(API_KEY) && Boolean(API_SECRET);
}
```
Captured at module load. Returns true only if the flag is `'true'` AND Twilio
credentials are present. Default is `false`.

**All read sites of `isVideoEnabled()` and `VIDEO_CONSULTATION_ENABLED`:**

| File | Line | Surface | Honored? |
|---|---|---|---|
| `src/routes/video.js` | 140 | GET `/portal/video/book/:orderId` — passes `videoEnabled` to view | ⚠️ **GET form is gated** (view shows banner + hides form when false — see `video_appointment.ejs:137–141`); but POST endpoint that the form would submit to is **not** gated. |
| `src/routes/video.js` | 278 | GET `/portal/video/pay/:appointmentId` — passes flag to view | ❌ No server-side check; payment page renders Paymob hosted-form regardless. |
| `src/routes/video.js` | 428 | GET `/portal/video/appointment/:id` — passes flag to view | ❌ No server-side check. |
| `src/routes/video.js` | 719 | POST `/api/video/token/:appointmentId` — only place that returns 503 | ✅ Honored. |
| `src/routes/video.js` | 1306 | GET `/portal/video/appointments` — passes flag to view | ❌ No server-side check. |
| `src/views/video_appointment.ejs` | 137 | hides booking form if `!videoEnabled` | ⚠️ View-only; bypassed by direct POST. |

**Surfaces NOT gated by `isVideoEnabled()` — verified by grep absence:**

| File | Line | Surface | Patient effect |
|---|---|---|---|
| `src/routes/video.js` | 147 | POST `/portal/video/book` | Creates `appointments` row with `status='pending_payment'`, `appointment_payments` row, `video_calls` row. Returns 302 to `/portal/video/pay/:id`. |
| `src/routes/video.js` | 232 | GET `/portal/video/pay/:appointmentId` | Renders Paymob hosted-form HTML with `payment_id`, `client_secret`, etc. |
| `src/routes/video.js` | 288 | POST `/portal/video/payment/callback` | Paymob webhook; updates `appointment_payments` to `paid`, advances `appointments` to `pending_doctor`, fires `queueNotification` for video_payment_confirmed (which itself uses the WhatsApp+email path). **Real money taken.** |
| `src/routes/payments.js` | 472–511 | Case-checkout addon `addon_video_consultation=1` query param branch in the main Paymob webhook for case payment | UPDATE `orders SET video_consultation_selected=true, video_consultation_price=$1`. Plus a `safeDualWrite('video_consult', 'onPurchase', ...)` that creates an `order_addons` row with `status='paid'` (via `src/services/addons/video_consult.js:18–38`). **Patient pays the video price as part of the case checkout, not the dedicated /portal/video flow.** |
| `src/routes/video.js` | 439 | POST `/portal/video/appointment/:id/reschedule` | No flag check. |
| `src/routes/video.js` | 549 | POST `/portal/video/appointment/:id/cancel` | No flag check. (Cancel-when-disabled is fine; included for completeness.) |

**Sequence diagram of the bypass:**
1. Patient finishes case checkout with `addon_video_consultation=1` selected.
2. Paymob webhook fires `payments.js:472`, marks order paid, charges video price,
   creates `order_addons` row.
3. Patient is shown a "book your video slot" CTA on the case detail page.
4. Patient navigates to `/portal/video/book/:orderId` — GET shows
   "Video consultations are currently unavailable" banner (good).
5. **Form is hidden, but POST endpoint is open.** A scripted client (or a
   future view that re-enables the form prematurely) can POST to
   `/portal/video/book` and create an appointment regardless of the flag.
6. Even ignoring the scripted-bypass risk, by step 2 the patient has already
   paid for video — the addon-purchase path doesn't consult the flag at all.
7. Doctor accepts case; doctor sees a video appointment they can't join
   (`/api/video/token` returns 503 when flag is off).
8. Manual refund needed; reputational damage.

**Severity: P0** per the original audit. The audit's claim is verified: **only
the join-button endpoint blocks; booking, payment-page render, and webhook all
proceed regardless.**

### Sub-issue D — Anthropic models hardcoded stale, no prompt caching

**All Anthropic call sites (verified by grep `claude-\|anthropic-version\|messages\.create`):**

| Call site | Style | Model string | API version | System-prompt size | Cache opportunity |
|---|---|---|---|---|---|
| `src/case-intelligence.js:243–251` | `@anthropic-ai/sdk` | `claude-sonnet-4-20250514` | SDK default | ~200 tokens | High — system prompt is static across thousands of file extractions |
| `src/routes/ai_assistant.js:115–121` | `@anthropic-ai/sdk` | `claude-sonnet-4-20250514` | SDK default | ~2–5KB (catalog-embedded) | Very high — catalog only changes on admin edits, system prompt re-sent on every chat turn |
| `src/ai_image_check.js:38–66` | raw `https.request` | `claude-sonnet-4-20250514` | `2023-06-01` (3-year-old default) | ~600 tokens (per-image, no system prompt) | Medium — per-image variation but the question template is static |
| `src/routes/patient.js:917` | raw `https.request` | `claude-haiku-4-5` | `2023-06-01` | one-shot prompt, ~150 tokens | Low — single call per analysis |
| `src/routes/order_flow.js:320` | (delegates to `validateMedicalImage`) | inherits ai_image_check | inherits | inherits | inherits |

**Module-load instantiation (also a small fragility per audit P1-INT-29):**
- `src/case-intelligence.js:17` — `var anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });`
- `src/routes/ai_assistant.js:7` — `const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });`

Both runs once at require-time. If `ANTHROPIC_API_KEY` is unset, the SDK
constructor doesn't throw (per `@anthropic-ai/sdk` docs the validation happens
lazily on the first `.create()` call), and the boot-time guard in
`src/server.js:51–68` catches the missing key and `process.exit(1)` before any
HTTP request lands. So in production this can't fire — the IIFE catches it.

**Centralised model string check:** zero occurrences of `process.env.ANTHROPIC_MODEL`
in `src/`. Zero occurrences of `process.env.CLAUDE_MODEL`. **No env override
exists.** Every model is a hardcoded literal in the source.

**Prompt caching check:** zero occurrences of `cache_control`, zero occurrences
of `prompt-caching`, `prompt_caching`, or `anthropic-beta`. **No prompt caching is in use anywhere.**

**Model freshness:** per the system context for this conversation, the most
recent Claude family is 4.X — Opus 4.7, Sonnet 4.6, Haiku 4.5. The hardcoded
`claude-sonnet-4-20250514` is from May 2025 (Sonnet 4.0). `claude-haiku-4-5`
is current. Anthropic does deprecate model IDs over time; per their model-deprecation
policy, stale IDs eventually 404 or fall back. Not launch-blocking *today*
(Sonnet 4.0 still works), but is a guaranteed launch-blocker on the deprecation
calendar without monitoring.

**Date last updated:** the `claude-sonnet-4-20250514` literal predates Theme 4
work (no Theme commits touch `case-intelligence.js`, `ai_image_check.js`, or
`ai_assistant.js`). `git log --oneline -- src/case-intelligence.js` (not
executed during this scoping pass; flagged as a §8 OQ if exact dates matter).

### Sub-issue E — Instagram token refresh never invoked

**Refresh function (`src/instagram/scheduler.js:121–128`):**
```javascript
async refreshToken() {
  console.log('[IG Scheduler] Refreshing access token...');
  const result = await this.client.refreshLongLivedToken();
  // Note: In production, you'd store the new token in DB/env.
  // For Render, you'll need to update the env var manually or via Render API.
  console.log(`[IG Scheduler] Token refreshed. Expires in ${Math.round(result.expiresIn / 86400)} days.`);
  return result;
}
```

**Underlying client method (`src/instagram/client.js:49–62`):**
```javascript
async refreshLongLivedToken() {
  const data = await this.request('/oauth/access_token', 'GET', {
    grant_type: 'fb_exchange_token',
    client_id: config.appId,
    client_secret: config.appSecret,
    fb_exchange_token: this.accessToken,
  });
  this.accessToken = data.access_token;
  return { accessToken, tokenType, expiresIn };
}
```

**Call sites of `refreshToken` / `refreshLongLivedToken` (verified by grep):**

| Caller | File | Line | Trigger |
|---|---|---|---|
| Manual admin endpoint | `src/instagram/routes.js` | 44 | `POST /api/admin/instagram/refresh-token` (mounted at `/api/admin/instagram`) |
| Scheduler `start()` | `src/instagram/scheduler.js` | 23–41 | **NOT a caller — `start()` only sets up `setInterval(publishDuePosts, 5min)`. No interval for refresh.** |
| pg-boss / cron | (none) | — | **Zero scheduled invocations across `src/server.js:1020–1080`** |

**Three independent breakage points (all confirmed):**

1. **Never scheduled.** `scheduler.start()` at lines 23–41 sets up exactly one
   `setInterval` for `publishDuePosts`. There is no analogous `setInterval` or
   `cron.schedule` for `refreshToken`. Token refresh only happens if a
   superadmin manually clicks the admin endpoint.

2. **In-memory only — not persisted.** `client.js:56` does `this.accessToken =
   data.access_token`. There is no DB write, no Render API call, no env-var
   mutation. The next time the process restarts (which Render does on every
   deploy), `config.js:11` re-reads `process.env.IG_ACCESS_TOKEN` and the
   in-memory refresh is lost.

3. **Not propagated to all consumers.** `scheduler.js:14–15` constructs both
   `this.publisher = new InstagramPublisher()` (which itself constructs a fresh
   `InstagramClient` at `publisher.js:11`) AND `this.client = new InstagramClient()`.
   These are **two independent `accessToken` fields**. `refreshToken()` updates
   `this.client.accessToken` only — the publisher's client (which is what
   actually publishes due posts) keeps the original. Even the in-memory refresh
   path is broken.

**Token expiry timeline:** Meta long-lived user tokens are documented to expire
~60 days. The Tashkheesa platform uses a long-lived Page-scope token via
`grant_type=fb_exchange_token` (`client.js:50–55`); same 60-day expiry.

**Behavior at expiry:** `client.request` at lines 33–45 throws
`InstagramApiError` for any Meta-side `data.error` (including the auth-expired
401). `publisher.publishImage / publishCarousel / publishStory / publishReel`
re-throws. Scheduler's `publishDuePosts` (lines 104–110) catches at the
per-post level and writes `error_message` to `ig_scheduled_posts`. **No alert,
no critical-alert ping, no email to admin.** Marketing automation simply stops
publishing.

**Severity:** non-launch-blocking. Instagram posting is marketing automation
— no patient sees it. But 60 days post-launch the marketing arm goes dark
silently.

### Sub-issue F — Other third-party integrations sweep

Scoped to the audit's enumerated integrations (Resend, Paymob, Uploadcare, R2,
Twilio Verify, Twilio Video, Tally). Looking specifically for **silent-failure
modes that don't surface to ops or to the user**.

#### F.1 — Resend (email)

**Failure paths:**

| Path | File:line | Failure mode |
|---|---|---|
| Templated `sendEmail()` | `emailService.js:360–423` | Writes `error_logs.category='email_send'` on miss. Returns `{ok:false, ...}`. Caller (notification worker) marks notification row `failed`. **No alert.** |
| Raw `sendRawEmail()` | `emailService.js:428–468` | Same. |
| Lifecycle `sendMail()` | `emailService.js:532–545` | If `RESEND_API_KEY` missing: **silent stub** — `console.warn('[MAILER STUB]')` and returns `{stub: true}`. Caller treats stub as success. **Same class of silent-degradation as the audit calls out.** |

**Verdict:** the templated paths now write to `error_logs` (Theme 1/4 work
landed this), so they are recoverable via `/ops/errors`. The stub path on
missing `RESEND_API_KEY` is the silent path. Theme 4 Sub-issue A (already
landed at commit `096211a`) elevated `RESEND_API_KEY` to a fail-fast at boot
in production, which closes the prod stub path. **Not adding a new finding.**

#### F.2 — Paymob

**Failure paths:**
- HMAC failure: `payments.js:228–234` calls `sendCriticalAlert` (which is
  itself broken — Sub-issue B). Once B is fixed, this becomes a real alert.
- Webhook for an unknown order: 404 returned; `payment_events` row written.
  No alert.
- `_assertTestMode()` throw: `services/paymob.js:39–46`. Surfaces as 502 to
  patient with `?failed=1`. No alert.
- Ops dashboard: `routes/ops.js:475–501` computes `paymobHealth` (last intention,
  last webhook, hmac_failures_24h) — **this is the one integration with a
  visibility card.**

**Verdict:** best-instrumented integration on the platform. Paymob's
silent-failure surface is small. Sub-issue B fix uplifts the HMAC alert. **Not
adding a new finding.**

#### F.3 — Uploadcare

**Server-side reads:** zero (verified by `grep "process.env.UPLOADCARE"`):
- `routes/auth.js:825` reads `UPLOADCARE_PUBLIC_KEY` for the doctor signup
  form's CSP allowance.
- `routes/verify.js:100–104` reads three aliases (already a P2 in the audit).
- `UPLOADCARE_SECRET_KEY` is **never read** (audit P1-INT-6 already documents this).

**Failure mode:** widget-side. Uploadcare's CDN returns 4xx → file URL is
empty in form submit → patient sees a generic "no files uploaded" error.

**New finding:** ⬇️ logged as `P3-INTEG-1` below.

#### F.4 — R2 (Cloudflare object storage)

**Failure paths:**
- Missing env: `storage.js:19–21` warns, doesn't throw. Theme 4 Sub-issue E
  proposed promoting to a prod fail-fast (commit `504711e` landed this).
- Runtime put/get failure: thrown to caller (`server.js:404–411`) → 500
  "File temporarily unavailable" page.

**Verdict:** Theme 4 closed the boot-time gap. The runtime failure mode is the
generic 500 page; ops has `/ops/errors` visibility (R2 errors land as `level='error'`,
no specific category — `P3-INTEG-2` below proposes adding one).

#### F.5 — Twilio Verify (mobile login OTP)

**Failure mode:** `services/twilio_verify.js:28` returns `null` if
`TWILIO_VERIFY_SERVICE_SID` is missing. `routes/api/auth.js:183–191` tracks
`wasStub` separately and falls through to the local `otp_codes` table-stored
code. **The stub path is the audit's P1-INT-9 finding** (cleartext OTP in DB
when Verify is configured but stubs).

**Verdict:** known finding; not duplicating.

#### F.6 — Twilio Video

**Failure mode:** Sub-issue C is the lead finding. Token TTL (3600s) is also
flagged as P1-INT-14. Not adding new findings.

#### F.7 — Tally (forms)

**Verdict:** **not present in codebase.** Verified by `grep -ri "tally\|TALLY"
src/ tests/ scripts/ .env.example` — zero matches. Audit's mention of "any
others discovered" — Tally was speculative in the brief and is not wired up.
No finding.

#### New findings logged (P3, do not block launch)

- **P3-INTEG-1** — Uploadcare widget-side failures are invisible to ops. When
  the CDN is degraded or the widget JS fails to load, the patient sees a generic
  "no files uploaded" error and the platform has no signal. **Sketch:** add a
  client-side `window.addEventListener('error', ...)` that POSTs to a
  `/api/v1/integration-error?source=uploadcare` endpoint to write a server-side
  `error_logs` row. ~50 lines, no behavior change.

- **P3-INTEG-2** — R2 runtime failures don't tag `error_logs.category`. They
  surface as `category=NULL` rows alongside generic uncaught errors. **Sketch:**
  thread `category='r2_storage'` through the `getSignedUrl` / `putObject`
  catch blocks in `src/server.js:404–418` and `src/routes/order_flow.js`. ~10
  lines.

- **P3-INTEG-3** — `error_logs.category` is set by only three writers
  (`whatsapp_send`, `email_send`, `admin_audit` per audit P0-ERR-5). The
  partial index from migration 035 is unused. The Theme 9 fix to add ops
  health cards relies on category-filterable queries; this index gap should be
  closed across all integrations in a post-launch sweep. **Sketch:** add a
  category param to `logErrorToDb()` and audit the 30+ existing call sites.
  Out of scope here; flagging for tracking.

---

## 3. Root Cause

Five threads converge on the same systemic failure:

1. **Alert path runs over the same wire as the thing it monitors.**
   WhatsApp critical-alert ships errors via WhatsApp. When WhatsApp dies, the
   alert dies with it. Sub-issues A and B are two faces of this single design
   error; fixing A without fixing B (or vice versa) leaves the loop open.

2. **Soft-fail return shapes mask outages.** Every integration was wired to
   return `{ok: false}` rather than throw. This was a deliberate choice (don't
   crash the request handler over a downstream outage), but no second-stage
   alerting or degradation switch was ever wired. The pattern is identical
   across WhatsApp, Resend, R2, Twilio, Anthropic.

3. **Module-load env capture across multiple files.** WhatsApp envs are
   destructured at file-top in two places (`notify/whatsapp.js:5–11` and
   `critical-alert.js:6–9`). Anthropic clients are instantiated at file-top in
   two places (`case-intelligence.js:17`, `ai_assistant.js:7`). IG token is
   captured at file-top in `instagram/config.js:11`. Token rotation requires
   a full process restart in every case.

4. **Feature flags don't gate every entrance.** `VIDEO_CONSULTATION_ENABLED`
   gates the GET-form view and the join-button endpoint, but not the booking
   POST or the payment webhook or the case-checkout addon path. The flag
   exists, just not consistently.

5. **Hardcoded model strings.** The `claude-sonnet-4-20250514` literal predates
   any model-rotation discipline. There is no `process.env.ANTHROPIC_MODEL`
   anywhere; cleanup never landed.

The deeper cause is that integrations were added at four different times by
different patterns: WhatsApp on the OTP flow, then again on the alert flow;
Anthropic on case-intelligence first then ai_assistant then ai_image_check;
Instagram in its own subdirectory; Resend in 2026-04-30 to replace SMTP. Each
retrofit copied from the most-recent prior pattern but never reconciled with
the others. The result is N parallel implementations of the same job.

---

## 4. Fix Plan

Each sub-issue lands as a separate atomic commit. Per the user's hard
constraint, **do not modify any source file in this commit** — this section
is the proposed diff for the next theme phase.

### Sub-issue A — Add the 401-detector job + ops health card (alerting half)

**Files:** `src/jobs/whatsapp_health_check.js` (new), `src/server.js` (register
cron), `src/routes/ops.js` (add `whatsappHealth` to render context),
`src/views/ops-dashboard.ejs` (new card).

**New file `src/jobs/whatsapp_health_check.js`:**
```javascript
// Periodic WhatsApp 401 detector. Runs every 15 min via node-cron.
// Counts error_logs rows with category='whatsapp_send' and status:401 in
// the last 15 min; if > 0, fires sendCriticalAlert (which itself must be
// fixed in Sub-issue B before this is useful).

const { execute, queryOne } = require('../pg');
const { sendCriticalAlert } = require('../critical-alert');

async function checkWhatsAppHealth() {
  const row = await queryOne(
    `SELECT COUNT(*)::int AS c
     FROM error_logs
     WHERE category = 'whatsapp_send'
       AND created_at > NOW() - INTERVAL '15 minutes'
       AND (context::jsonb)->>'status' = '401'`
  );
  if (row && row.c > 0) {
    sendCriticalAlert(
      `WhatsApp 401 detected: ${row.c} send failures in last 15min. ` +
      `Token may have expired — check Render env WHATSAPP_ACCESS_TOKEN.`
    );
  }
  return row ? row.c : 0;
}

module.exports = { checkWhatsAppHealth };
```

**Server registration (`src/server.js:1020`-region, mirroring the appointment
reminder cron pattern):**
```diff
+ // WhatsApp 401-detector cron
+ try {
+   var whatsappHealthCron = require('node-cron');
+   var checkWhatsAppHealth = require('./jobs/whatsapp_health_check').checkWhatsAppHealth;
+   whatsappHealthCron.schedule('*/15 * * * *', function() {
+     try { checkWhatsAppHealth(); } catch (_) {}
+   });
+   logMajor('WhatsApp 401-detector cron registered (every 15 min)');
+ } catch (waHealthErr) {
+   logMajor('WhatsApp health cron registration failed: ' + waHealthErr.message);
+ }
```

**Ops dashboard card (in `src/routes/ops.js` near `paymobHealth`):**
```diff
+ var waLast15min = ((await safeGet(
+   "SELECT COUNT(*)::int AS c FROM error_logs WHERE category='whatsapp_send' AND (context::jsonb)->>'status'='401' AND created_at > NOW() - INTERVAL '15 minutes'",
+   [], { c: 0 }
+ )) || {}).c || 0;
+ var waLast24h = ((await safeGet(
+   "SELECT COUNT(*)::int AS c FROM error_logs WHERE category='whatsapp_send' AND created_at > NOW() - INTERVAL '24 hours'",
+   [], { c: 0 }
+ )) || {}).c || 0;
+ var whatsappHealth = {
+   token401Last15min: Number(waLast15min),
+   sendErrorsLast24h: Number(waLast24h)
+ };
```

**Render context + view card** — same pattern as `paymobHealth` rendering
at `ops-dashboard.ejs:228+`.

**Why this is the smallest viable fix:** the alerting path itself depends on
Sub-issue B landing. We can pre-wire the cron + the ops card with the patch
above; the WhatsApp ping inside it will only function once B is in. The ops
dashboard card is functional immediately without B.

**What this does NOT do (deferred to follow-up theme):**
- Switch WhatsApp template sends to a Meta utility-template re-engagement.
  Requires Meta verification clearance.
- Add a fallback channel (WhatsApp → email) on persistent 401. Requires the
  Resend health work + a degradation-state DB column.
- Re-read envs on every send. Discussed below as part of Sub-issue B fix.

### Sub-issue B — Fix `critical-alert.js` (template body + per-call env read)

**File:** `src/critical-alert.js` (rewrite).

**Diff sketch (whole-file replacement, ~80 lines):**
```javascript
// src/critical-alert.js — rewrite
// Send critical WhatsApp alerts via Meta utility-template, throttled 1/5min,
// envs read at call time so token rotation does not require a restart.

const fetch = require('node-fetch');

const THROTTLE_MS = 5 * 60 * 1000;
let lastSentAt = 0;

async function sendCriticalAlert(message) {
  const now = Date.now();
  if (now - lastSentAt < THROTTLE_MS) return { skipped: 'throttled' };

  // Re-read envs every call — never capture at module load.
  const adminPhone = (process.env.ADMIN_PHONE || '').replace(/[^0-9]/g, '');
  const phoneNumberId = (process.env.WHATSAPP_PHONE_NUMBER_ID || '').trim();
  const token = (process.env.WHATSAPP_ACCESS_TOKEN || '').trim();
  const apiVersion = (process.env.WHATSAPP_API_VERSION || 'v22.0').trim();
  const templateName = (process.env.CRITICAL_ALERT_TEMPLATE_NAME || '').trim();
  const templateLang = (process.env.CRITICAL_ALERT_TEMPLATE_LANG || 'en').trim();

  if (!adminPhone || !phoneNumberId || !token) {
    return { skipped: 'env_missing' };
  }
  if (!templateName) {
    // No template configured — can't send free-form text outside 24h window.
    // Fall back to console.error only. The ops health card still surfaces.
    console.error('[critical-alert] no CRITICAL_ALERT_TEMPLATE_NAME set; skipping WA send');
    return { skipped: 'template_not_configured' };
  }

  lastSentAt = now;
  const text = String(message || 'Unknown error').slice(0, 1000);

  const body = {
    messaging_product: 'whatsapp',
    to: adminPhone,
    type: 'template',
    template: {
      name: templateName,
      language: { code: templateLang },
      components: [{
        type: 'body',
        parameters: [{ type: 'text', text }]
      }]
    }
  };

  try {
    const url = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      timeout: 10000
    });
    if (!res.ok) {
      // Inspect status; write to error_logs so the WA-401 detector picks it up.
      console.error('[critical-alert] WA send failed', { status: res.status });
      // Soft-fail — do not throw from a crash handler.
      return { ok: false, status: res.status };
    }
    return { ok: true };
  } catch (err) {
    console.error('[critical-alert] exception:', err && err.message);
    return { ok: false, error: err && err.message };
  }
}

module.exports = { sendCriticalAlert };
```

**Three behavioral changes:**
1. Envs read on every call (line-by-line inside `sendCriticalAlert`), not at
   module load.
2. `type:'text'` becomes `type:'template'` with a Meta-approved utility
   template (configurable via env). Operates outside the 24h window.
3. Errors and statuses are inspected, logged to console, and (separately, via
   the WA-401 cron from Sub-issue A) surface in `error_logs`.

**Throttle counter caveat:** still per-process and still resets on
`process.exit(1)`. **Not fixed in this rewrite** — the structural fix is to
move the throttle to a DB row (a `last_sent_at` column on a `critical_alert_state`
table), which is too large for this theme. Logged as deferred follow-up.

**.env.example additions (paired diff):**
```diff
+# ── Critical alert WhatsApp template ──────────────────────────────────────────
+# Required for sendCriticalAlert to fire outside Meta's 24h customer-service
+# window. Provision a utility-category template via Meta Business Manager
+# with one body param (the alert text).
+CRITICAL_ALERT_TEMPLATE_NAME=
+CRITICAL_ALERT_TEMPLATE_LANG=en
```

### Sub-issue C — Gate every video booking + payment surface

**File:** `src/routes/video.js` + `src/routes/payments.js`.

**`video.js:147` POST `/portal/video/book`:**
```diff
 router.post('/portal/video/book', requireRole('patient'), async (req, res) => {
+  if (!isVideoEnabled()) {
+    return res.status(503).json({ ok: false, error: 'video_disabled' });
+  }
   const lang = getLang(req);
   const { order_id, scheduled_at } = req.body;
```

**`video.js:232` GET `/portal/video/pay`:**
```diff
 router.get('/portal/video/pay/:appointmentId', requireRole('patient'), async (req, res) => {
+  if (!isVideoEnabled()) {
+    return res.redirect('/dashboard?msg=video_unavailable');
+  }
   const lang = getLang(req);
```

**`video.js:288` POST `/portal/video/payment/callback`:**
The Paymob webhook is trickier — Paymob will retry the webhook if we 503. The
right pattern is to **mark the payment as paid (so we don't owe Paymob an
auto-refund) but route the appointment to a `disabled_post_payment` state
that triggers a manual refund.**
```diff
 router.post('/portal/video/payment/callback', async (req, res) => {
   const hmacSecret = process.env.PAYMOB_HMAC_SECRET;
   if (!hmacSecret) return res.status(503).json({ ok: false, error: 'webhook_not_configured' });
   const hmacResult = verifyPaymobHmac(req, hmacSecret);
   if (!hmacResult.ok) return res.status(401).json({ ok: false, error: 'unauthorized' });
+  if (!isVideoEnabled()) {
+    // Acknowledge the webhook (don't make Paymob retry) but mark for refund.
+    // Operations team handles refund out-of-band.
+    sendCriticalAlert(
+      'Video payment received with VIDEO_CONSULTATION_ENABLED=false. ' +
+      'Manual refund needed for payment_id=' + (req.body && req.body.obj && req.body.obj.payment_id)
+    );
+    return res.json({ ok: true, note: 'video_disabled_manual_refund_required' });
+  }
```

**`payments.js:472` (case-checkout addon branch):**
```diff
   const addonVideoConsultation = req.query?.addon_video_consultation || req.body?.addon_video_consultation;

   if (addonVideoConsultation === '1' || addonVideoConsultation === 1) {
+    const { isVideoEnabled } = require('../video_helpers');
+    if (!isVideoEnabled()) {
+      // Patient picked a video addon but the feature is off. Don't charge
+      // the addon; log and skip. The case payment proceeds normally.
+      console.error('[payments] video_consultation addon requested but feature disabled');
+      logOrderEvent({
+        orderId,
+        label: 'video_consultation_addon_skipped_feature_disabled',
+        meta: '{}',
+        actorRole: 'system'
+      });
+    } else {
       try {
         const service = await queryOne('SELECT * FROM services WHERE id = $1', [order.service_id]);
         // ... existing branch ...
       } catch (e) { /* ... */ }
+    }
   }
```

**Note:** the upstream wizard EJS that *adds* the `addon_video_consultation=1`
to the checkout URL also needs to consult the flag. That's an EJS edit
(`src/views/patient_payment_required.ejs:168` checkbox should be hidden when
flag is off). Out of strict scope for the route fix but flagged.

**Open question for Ziad:** is it acceptable to **hard-block the entire
`/portal/video/*` route subtree** when the flag is off, vs. the surgical
per-route gates above? A `app.use('/portal/video', requireVideoEnabled)` middleware
would be smaller but breaks ongoing appointments mid-call. The surgical approach
above lets in-flight appointments finish (existing rows still have valid
join paths) while blocking new bookings. **Recommendation: surgical.**

### Sub-issue D — Centralise model strings + add prompt caching

**File:** new `src/config/anthropic.js`, then four call-site edits.

**New file `src/config/anthropic.js`:**
```javascript
// Single source of truth for Anthropic model selection across the codebase.
// Defaults reflect the canonical model family at deploy time; override per env.

const DEFAULT_SONNET = 'claude-sonnet-4-5';   // case extraction, ai_assistant
const DEFAULT_HAIKU  = 'claude-haiku-4-5';    // case-type triage
const DEFAULT_VISION = 'claude-sonnet-4-5';   // medical image quality check

function modelSonnet() {
  return (process.env.ANTHROPIC_MODEL_SONNET || '').trim() || DEFAULT_SONNET;
}
function modelHaiku() {
  return (process.env.ANTHROPIC_MODEL_HAIKU || '').trim() || DEFAULT_HAIKU;
}
function modelVision() {
  return (process.env.ANTHROPIC_MODEL_VISION || '').trim() || DEFAULT_VISION;
}

module.exports = { modelSonnet, modelHaiku, modelVision };
```

**Call-site edits (all four):**

| File:line | Before | After |
|---|---|---|
| `case-intelligence.js:244` | `model: 'claude-sonnet-4-20250514'` | `model: modelSonnet()` |
| `ai_assistant.js:116` | `model: 'claude-sonnet-4-20250514'` | `model: modelSonnet()` |
| `ai_image_check.js:39` | `model: 'claude-sonnet-4-20250514'` | `model: modelVision()` |
| `routes/patient.js:917` | `model: 'claude-haiku-4-5'` | `model: modelHaiku()` |

**Prompt caching — high-value targets:**

The `claude-api` skill recommends caching for stable prefixes ≥ 1024 tokens
(or ≥ 2048 for Haiku). Two call sites qualify:

1. **`ai_assistant.js:115–121`** — system prompt embeds a 5-min-cached
   service catalog (~2–5KB of stable text). Every chat turn re-sends it.
   ```diff
    const response = await client.messages.create({
      model: modelSonnet(),
      max_tokens: 400,
   -  system: systemPrompt,
   +  system: [
   +    { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }
   +  ],
      messages: validMessages,
      timeout: 30000,
    });
   ```
   Expected savings: ~90% on prefix tokens after the first call within the
   5-min cache window. Real money on a chat-shaped workload.

2. **`case-intelligence.js:243–251`** — `EXTRACTION_SYSTEM_PROMPT` and the static
   prefix of `EXTRACTION_USER_PROMPT` are identical across every file
   extracted. Wrap both:
   ```diff
    var response = await anthropic.messages.create({
      model: modelSonnet(),
      max_tokens: 4096,
   -  system: EXTRACTION_SYSTEM_PROMPT,
   -  messages: [{
   -    role: 'user',
   -    content: EXTRACTION_USER_PROMPT + text
   -  }]
   +  system: [
   +    { type: 'text', text: EXTRACTION_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }
   +  ],
   +  messages: [{
   +    role: 'user',
   +    content: [
   +      { type: 'text', text: EXTRACTION_USER_PROMPT, cache_control: { type: 'ephemeral' } },
   +      { type: 'text', text }
   +    ]
   +  }]
    });
   ```

**Skip caching for:**
- `routes/patient.js:917` — single-shot, no stable prefix worth caching.
- `ai_image_check.js` — every image is unique base64; the question template
  is short (~600 tokens) and below the 1024-token threshold for Sonnet caching.

**Migration path note:** the `claude-api` skill recommends keeping
`anthropic-version: 2023-06-01` since Anthropic doesn't deprecate API versions.
The `cache_control` markers don't require a beta header in the current SDK
(per the skill's cache-control-first guidance) — the SDK auto-includes the
required header when `cache_control` is set. The raw `https.request` paths
(`ai_image_check.js`, `routes/patient.js`) would need the
`anthropic-beta: prompt-caching-2024-07-31` header added; since neither is a
caching target, no change needed.

**.env.example additions:**
```diff
+# ── AI: Anthropic model selection ─────────────────────────────────────────────
+# Override the per-pipeline default model. Leave blank to use the in-code
+# default, which tracks the canonical Claude family at deploy time. Update
+# these on Anthropic model rotation, no code change required.
+ANTHROPIC_MODEL_SONNET=
+ANTHROPIC_MODEL_HAIKU=
+ANTHROPIC_MODEL_VISION=
```

### Sub-issue E — Wire IG token refresh to a daily cron

**File:** `src/instagram/scheduler.js` (extend `start()`), `src/instagram/client.js`
(persist via DB), `src/migrations/<NEW>_ig_token_state.sql` (new table).

**New migration `<NEW>_ig_token_state.sql`:**
```sql
CREATE TABLE IF NOT EXISTS ig_token_state (
  id           int PRIMARY KEY DEFAULT 1,           -- single-row table
  access_token text NOT NULL,
  expires_at   timestamptz NOT NULL,
  refreshed_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT ig_token_state_singleton CHECK (id = 1)
);
```

**Scheduler `start()` extension:**
```diff
   start() {
     if (!process.env.IG_ACCESS_TOKEN) {
       console.log('[IG Scheduler] No IG_ACCESS_TOKEN set, skipping Instagram scheduler.');
       return;
     }
     console.log('[IG Scheduler] Starting — checking for posts every 5 minutes.');
     this.publishDuePosts().catch(err => console.error('[IG Scheduler] Initial run error:', err.message));
     this.intervalId = setInterval(async () => {
       try { await this.publishDuePosts(); } catch (err) { console.error('[IG Scheduler] Error:', err.message); }
     }, 5 * 60 * 1000);
+
+    // Daily token refresh — Meta long-lived tokens expire ~60 days, refresh weekly to stay well clear.
+    this.refreshIntervalId = setInterval(async () => {
+      try { await this.refreshTokenAndPersist(); }
+      catch (err) { console.error('[IG Scheduler] Token refresh error:', err.message); }
+    }, 7 * 24 * 60 * 60 * 1000);  // every 7 days
+    // Also run once at boot so a fresh deploy refreshes the token immediately.
+    setTimeout(() => this.refreshTokenAndPersist().catch(() => {}), 30000);
   }
```

**New method `refreshTokenAndPersist`:**
```javascript
async refreshTokenAndPersist() {
  const result = await this.client.refreshLongLivedToken();
  // Propagate to publisher's client too.
  if (this.publisher && this.publisher.client) {
    this.publisher.client.accessToken = result.accessToken;
  }
  // Persist to DB so subsequent process restarts can pick up the latest token.
  await execute(
    `INSERT INTO ig_token_state (id, access_token, expires_at, refreshed_at)
     VALUES (1, $1, NOW() + ($2 || ' seconds')::interval, NOW())
     ON CONFLICT (id) DO UPDATE SET
       access_token = EXCLUDED.access_token,
       expires_at = EXCLUDED.expires_at,
       refreshed_at = EXCLUDED.refreshed_at`,
    [result.accessToken, String(result.expiresIn)]
  );
  console.log('[IG Scheduler] Token refreshed + persisted; expires in ' + Math.round(result.expiresIn / 86400) + ' days');
}
```

**Boot-time read in `instagram/config.js`:**
```diff
-module.exports = {
-  // ...
-  accessToken: process.env.IG_ACCESS_TOKEN,
-  // ...
-};
+function getAccessToken() {
+  // Prefer DB-persisted refreshed token; fall back to env for fresh deploys.
+  // Async lookup is too heavy for a config module; treat env as source of
+  // truth for boot, and let scheduler.refreshTokenAndPersist() update both
+  // DB and the publisher client's in-memory copy on the daily cycle.
+  return process.env.IG_ACCESS_TOKEN;
+}
+module.exports = {
+  // ...
+  get accessToken() { return getAccessToken(); },
+  // ...
+};
```

**Note:** rolling forward without persisting to env requires the scheduler's
in-memory propagation to be the source of truth between deploys. On a fresh
deploy after >60 days without a refresh, the env-stored token *will* have
expired, so the first refresh on boot is the recovery path. If the env token
itself has already expired by the time the deploy lands, recovery requires a
manual refresh from the Meta Business Manager into the Render env. **Logged
as an OQ for Ziad.**

**Severity defer:** Sub-issue E is the lowest priority of the five. Marketing
automation is non-launch-critical. Recommend deferring to a follow-up theme.

### Sub-issue F — Add P3-INTEG findings to follow-up backlog

No code changes from this theme; the three discovered findings are logged in
§2 sub-issue F above (`P3-INTEG-1` through `P3-INTEG-3`).

---

## 5. Verification Steps

Each verification corresponds to a sub-issue.

### V1 — Sub-issue A: prove a 401 from WhatsApp surfaces visibly

1. **Local 401 simulation.** With `WHATSAPP_ENABLED=true` and a deliberately
   bogus `WHATSAPP_ACCESS_TOKEN`, fire a queueNotification on the
   `whatsapp` channel and run the worker:
   ```bash
   WHATSAPP_ENABLED=true \
   WHATSAPP_PHONE_NUMBER_ID=<real_id> \
   WHATSAPP_ACCESS_TOKEN=expired_or_bogus_token \
   node -e "require('./src/notify/whatsapp').sendWhatsApp({ to:'+201234567890', template:'otp_verify_en', vars:{ otp_code:'123456' }}).then(console.log)"
   ```
   Expect: stdout JSON `{ok:false, status:401, ...}`.
2. **Database evidence.** A row in `error_logs` with
   `category='whatsapp_send'`, `message='wa_meta_api_error'`,
   `(context::jsonb)->>'status' = '401'`. Verify via:
   ```sql
   SELECT id, message, (context::jsonb)->>'status' AS status, created_at
   FROM error_logs WHERE category='whatsapp_send' ORDER BY created_at DESC LIMIT 5;
   ```
3. **Cron fires the alert.** With the new cron registered, advance system
   time by 15 minutes (or trigger manually):
   ```bash
   node -e "require('./src/jobs/whatsapp_health_check').checkWhatsAppHealth().then(console.log)"
   ```
   Expect: prints the count of 401s. If > 0 and Sub-issue B has landed,
   `sendCriticalAlert` is invoked and (with `CRITICAL_ALERT_TEMPLATE_NAME`
   set) Meta receives a template-message request.
4. **Ops dashboard card visible.** GET `/ops` (with `OPS_USER` / `OPS_PASS`
   basic auth) and verify the new `whatsappHealth.token401Last15min` and
   `sendErrorsLast24h` numbers render in the integration-health section.

### V2 — Sub-issue B: prove `critical-alert.js` works outside the 24h window

1. **Mock test (no real Meta call).** A new test file
   `tests/core/critical-alert-template.test.js` should:
   - Stub `node-fetch` to return `{ok:true, status:200}`.
   - Set `CRITICAL_ALERT_TEMPLATE_NAME=critical_alert_v1`,
     `WHATSAPP_ACCESS_TOKEN=<bogus>`, `ADMIN_PHONE=...`,
     `WHATSAPP_PHONE_NUMBER_ID=...`.
   - Invoke `sendCriticalAlert('test')` and capture the request body the
     module passes to `node-fetch`.
   - Assert the body `.type === 'template'` and
     `.template.name === 'critical_alert_v1'` and
     `.template.components[0].parameters[0].text === 'test'`.
2. **Env-rotation test.** A second test file
   `tests/core/critical-alert-env-rotation.test.js`:
   - `process.env.WHATSAPP_ACCESS_TOKEN = 'old_token';`
   - `const { sendCriticalAlert } = require('../../src/critical-alert');`
   - `process.env.WHATSAPP_ACCESS_TOKEN = 'new_token';`
   - Invoke `sendCriticalAlert(...)`; capture the `Authorization` header.
   - Assert `Authorization === 'Bearer new_token'` (proves env is read on
     every call, not at module load).
3. **Throttle test.** Two consecutive `sendCriticalAlert` calls within the
   throttle window — second returns `{skipped: 'throttled'}`.
4. **Real-environment smoke test (post-deploy).** Once
   `CRITICAL_ALERT_TEMPLATE_NAME` is set on Render, manually trigger an
   unhandledRejection in a staging deploy:
   ```bash
   curl -X POST <STAGING_URL>/ops/test/trigger-crash --basic <ops_creds>
   ```
   (assumes a `/ops/test/trigger-crash` admin route exists; if not, add one
   guarded by `MODE !== 'production'`). Expect: ADMIN_PHONE receives the
   utility-template message within 10 seconds. *Caveat:* requires Meta
   verification and template approval.

### V3 — Sub-issue C: prove `VIDEO_CONSULTATION_ENABLED` is honored everywhere

1. **Static grep.** After the patch:
   ```bash
   grep -rn "isVideoEnabled\|VIDEO_CONSULTATION_ENABLED" src/routes/ src/views/ src/services/addons/
   ```
   Expect: every video-related route handler (booking GET, booking POST,
   payment-page render, payment callback, addon onPurchase) appears in the
   results.
2. **Direct-POST bypass test.**
   ```bash
   VIDEO_CONSULTATION_ENABLED=false node src/server.js &
   curl -X POST http://localhost:3000/portal/video/book \
     -H 'Cookie: <patient_session>' \
     -d 'order_id=...&scheduled_at=...'
   ```
   Expect: 503 with `{ok:false, error:'video_disabled'}`. Verify no row was
   inserted into `appointments`:
   ```sql
   SELECT count(*) FROM appointments WHERE created_at > NOW() - INTERVAL '1 minute';
   ```
   Should be zero.
3. **Webhook bypass test.** Synthesize a Paymob webhook POST with valid HMAC
   targeting an `appointment_payments` row. With flag off, expect: 200 OK with
   `note:'video_disabled_manual_refund_required'` and a `sendCriticalAlert`
   fire (verify via the alert path test from V2).
4. **Case-checkout addon test.** Drive a case checkout with
   `addon_video_consultation=1` while flag is off. Expect: order paid as
   normal, no `order_addons` row created with `addon_service_id='video_consult'`,
   and a `logOrderEvent` row with `label='video_consultation_addon_skipped_feature_disabled'`.

### V4 — Sub-issue D: prove model strings + caching land cleanly

1. **No literal model strings in source.**
   ```bash
   grep -rn "'claude-sonnet-4-2025\|'claude-haiku-4-5'" src/
   ```
   Expect: zero matches except in `src/config/anthropic.js` defaults.
2. **Env override works.** Set `ANTHROPIC_MODEL_SONNET=claude-sonnet-4-6`
   and verify a single Anthropic call uses the override:
   ```bash
   ANTHROPIC_MODEL_SONNET=claude-sonnet-4-6 \
   node -e "console.log(require('./src/config/anthropic').modelSonnet())"
   ```
   Expect: `claude-sonnet-4-6`.
3. **Cache-hit verification.** After fix lands, fire `/ai/help-me-choose`
   twice in quick succession with the same catalog. Inspect Anthropic SDK
   debug output (set `ANTHROPIC_LOG=info` env if available) for
   `cache_creation_input_tokens` on call 1 and `cache_read_input_tokens` on
   call 2. The Anthropic dashboard's per-request breakdown also shows cache
   hit ratio post-deploy. Real-money proof.

### V5 — Sub-issue E: prove IG token refresh fires

1. **Cron registration log.** On boot, `Instagram scheduler started` and
   `[IG Scheduler] Token refresh cron registered (every 7 days)` should
   appear in stdout. Grep server logs for the latter line.
2. **DB row written on first refresh.** 30 seconds after boot:
   ```sql
   SELECT id, expires_at, refreshed_at FROM ig_token_state;
   ```
   Expect one row, `refreshed_at` within the last minute.
3. **Publisher propagation.** Manually trigger `igScheduler.refreshTokenAndPersist()`
   and assert `igScheduler.publisher.client.accessToken === igScheduler.client.accessToken`
   afterward.
4. **Token-survives-restart smoke test.** Refresh once via the new cron,
   record `expires_at`, restart the process, and refresh again. Expect the
   new `expires_at` extends from the previously-persisted token, not from
   the env-original.

### V6 — Sub-issue F: confirm new findings tracked

No verification — these are P3 backlog entries. Logged.

---

## 6. What to Add to the Test Suite

Five new test files, mirroring the lint-test pattern from Theme 4.

### T1: `tests/core/whatsapp-health-cron.test.js`

Simulates a 401 row in `error_logs` (via direct insert) and asserts
`checkWhatsAppHealth()` returns the expected count and invokes
`sendCriticalAlert` (mocked). Covers Sub-issue A's alerting plumbing
end-to-end without hitting real Meta.

### T2: `tests/core/critical-alert-template-body.test.js`

Per V2, asserts the request body to Meta uses `type:'template'` and the
configured `CRITICAL_ALERT_TEMPLATE_NAME`. Mocks `node-fetch`. Catches
regression to free-form `text`.

### T3: `tests/core/critical-alert-env-rotation.test.js`

Per V2, asserts envs are re-read on every call. Sets a token, requires the
module, mutates the env, re-invokes — verifies the new token reaches the
Authorization header.

### T4: `tests/core/video-flag-enforcement.test.js`

Per V3, asserts every video-route handler (booking POST, payment-page GET,
webhook POST, case-checkout addon) refuses requests when `VIDEO_CONSULTATION_ENABLED=false`.
Uses supertest against the Express app.

### T5: `tests/core/anthropic-model-centralisation.test.js`

Static lint test: reads every `.js` file in `src/`, regex-searches for
hardcoded `claude-` model literals, asserts the only matches are in
`src/config/anthropic.js`. Modelled after Theme 4's
`tests/core/no-mobile-api-boot-script.test.js` lint-style.

### T6 (optional): `tests/core/ig-token-state-table.test.js`

Asserts the migration `<NEW>_ig_token_state.sql` creates the singleton table
and that `refreshTokenAndPersist` UPSERTs correctly. Skip if Sub-issue E is
deferred.

Add T1–T5 to `package.json`'s `npm test` and the existing CI / Render
pre-deploy gate.

---

## 7. Rollback Plan

Six commits in the proposed land order; each is independently revertable.

| Commit | Files touched | Rollback | Caveat |
|---|---|---|---|
| Sub-issue A | `src/jobs/whatsapp_health_check.js` (new), `src/server.js` (cron register), `src/routes/ops.js`, `src/views/ops-dashboard.ejs` | `git revert <sha>` | Removes the cron + ops card; `error_logs` rows still persist (no data loss). The cron is best-effort — revert is zero-impact. |
| Sub-issue B | `src/critical-alert.js`, `.env.example` | `git revert <sha>` | Restores the broken module. **Caveat:** if `CRITICAL_ALERT_TEMPLATE_NAME` was set in Render, leave it set — the old code ignores it. |
| Sub-issue C | `src/routes/video.js`, `src/routes/payments.js`, `src/views/patient_payment_required.ejs` (checkbox hide) | `git revert <sha>` | Restores the audit's P0 — patients can again pay for disabled video. **Pre-condition before revert:** confirm the flag is in its expected state (false in pre-launch, intended to flip true at launch). |
| Sub-issue D — model strings | `src/config/anthropic.js` (new), 4 call-site edits | `git revert <sha>` | Returns to hardcoded literals. Zero behavior change in prod. |
| Sub-issue D — caching | `case-intelligence.js`, `ai_assistant.js` cache_control diffs | `git revert <sha>` | Cache markers removed; subsequent calls fall through to non-cached path. Slight cost increase, no functional regression. |
| Sub-issue E | `src/instagram/scheduler.js`, `src/instagram/client.js`, new migration | `git revert <sha>` + DB rollback `DROP TABLE ig_token_state` | Migration reversal needs a follow-up `DOWN` migration; defer the table drop until after the revert is confirmed stable. |
| Tests T1–T6 | `tests/core/*.test.js` | `git revert <sha>` | Test-only — never runtime. |

If multiple commits need to be reverted, prefer a single
`git revert <oldest>..<newest>` in chronological order so the dependency
graph stays consistent (Sub-issue A depends on Sub-issue B for the alert path
to actually fire).

---

## 8. Open Questions for Ziad

### OQ-1: Which sub-issues are blocked on Meta verification?

Per the brief, Ziad is mid-Meta-verification. The following pieces depend
on it clearing:

- **Sub-issue A (real alert path):** the WA-401 cron will *fire* without
  Meta verification, but `sendCriticalAlert` (post-Sub-issue B) needs an
  approved utility template (`CRITICAL_ALERT_TEMPLATE_NAME`) to actually
  deliver. The cron's `console.error` and the `error_logs` writes work
  regardless.
- **Sub-issue B (real delivery):** same — the rewrite is correct without
  Meta verification, but `template_not_configured` short-circuits if the
  env var isn't set.
- **Sub-issue D, E:** unaffected by Meta.
- **Sub-issue C:** unaffected by Meta.

**Recommendation:** land Sub-issues B + C + D this theme; land the
Sub-issue A alerting plumbing this theme but leave the
`CRITICAL_ALERT_TEMPLATE_NAME` env unset until Meta clears (the code
gracefully no-ops). Defer the WhatsApp template-rewrite portion of A's
"full fix" (the user-facing path also using templates outside 24h) to a
follow-up theme post-Meta. Defer Sub-issue E entirely until after launch.

**Confirm:** is this prioritisation what you want?

### OQ-2: What's the canonical Sonnet model for production today?

The proposed default in `src/config/anthropic.js` is `claude-sonnet-4-5`. Per
the system context for this conversation, the most recent Sonnet is 4.6 — but
the question is what's stable on **your** Anthropic API tier (model
availability sometimes lags between tiers). Two options:

- **Pin to `claude-sonnet-4-5`** (proposed): older, more widely available,
  acceptable performance for medical extraction.
- **Pin to `claude-sonnet-4-6`**: latest, fewer tokens for the same task,
  may not be available on your API tier.

**Recommendation:** check the Anthropic dashboard, then set
`ANTHROPIC_MODEL_SONNET` explicitly on Render (which overrides whatever
default we ship). The default in code is just a fallback for fresh-clone
ergonomics. **Confirm:** which Sonnet do you want as the in-code default?

### OQ-3: Is Sub-issue E's DB-persisted token strategy acceptable?

The proposed strategy persists the refreshed token in a new `ig_token_state`
table and updates the publisher's in-memory client on each refresh, but does
**not** mutate the Render env var. A fresh deploy still reads
`IG_ACCESS_TOKEN` from the env, then refreshes 30s later.

**Risk:** if the env-stored token has already expired before the next deploy,
the boot-time refresh will fail, and Instagram posting stays dark until ops
manually rotates the env. Two ways to harden:

- **Render API integration:** call Render's PUT-env API to overwrite
  `IG_ACCESS_TOKEN` after each refresh. Adds a Render API token to the env
  surface; not free.
- **Read DB-stored token at boot:** `instagram/config.js` queries `ig_token_state`
  on first request and prefers the DB row if newer than the env. Slightly
  more complex; avoids the Render API dependency.

**Recommendation:** if Sub-issue E lands, prefer the DB-read-at-boot pattern;
add a Render-API option as a follow-up. **Confirm:** OK to defer Sub-issue E
entirely, or land the DB-read-at-boot variant?

### OQ-4: Should Sub-issue A also add a `notify` channel fallback?

The audit's full fix (per P2-INT-21) includes a degradation switch: when
WhatsApp has been failing for N consecutive sends across users, automatically
re-route notifications from `channels:['whatsapp']` to `channels:['email']`.
This is a meaningful behavioural change to the notification worker
(`src/notification_worker.js:244–256`).

**Scope:** medium — adds a
`degradation_state` column or a static in-memory fallback counter, plus a
banner to admins.

**Recommendation:** defer to a separate theme. The Sub-issue A alerting
plumbing surfaces the problem fast; ops can manually flip a feature flag
(once one exists) until automation is added. **Confirm:** OK to defer?

### OQ-5: For Sub-issue C, is hard-block of `/portal/video/*` acceptable, or do you want surgical gates?

The plan as written uses **surgical per-route gates**, which lets in-flight
appointments finish their cycle but blocks new bookings. The alternative is
a single `app.use('/portal/video', requireVideoEnabled)` middleware that
locks the entire route subtree.

**Trade-off:**
- Surgical: more complex; correctly handles patients who paid before the
  flag was flipped (they can still join the call, doctor can still review).
- Hard-block: simpler; breaks any patient mid-booking who was about to join.

**Recommendation:** surgical. **Confirm:** which?

### OQ-6: On the `claude-sonnet-4-20250514` literal — should we audit for stealth deprecation today, or wait?

That literal is from May 2025. Per Anthropic's deprecation calendar, models
get a 6-month deprecation window before retirement. May 2025 → November 2025
+ 6 months = May 2026 minimum. We're at 2026-05-10. **Today's date is
within the deprecation window.** This is not a hypothetical — checking
the Anthropic dashboard for `claude-sonnet-4-20250514` deprecation status
is a launch-week task.

**Recommendation:** check `https://docs.claude.com/en/docs/about-claude/model-deprecations`
this week, before launch. If the model has a deprecation date inside the launch
window, Sub-issue D goes from P1 to P0. **Confirm:** can you check this?

### OQ-7: Should `WHATSAPP_API_VERSION` be unified before launch?

Theme 9 doesn't address audit P1-INT-19 (two modules hardcode `v22.0`). The
fix is small (single source of truth in a new `src/config/whatsapp.js`).
Could fold into Sub-issue B's rewrite. **Confirm:** include in B, or out
of scope?

---

## Appendix: discovered-but-deferred items

Logged here so they can be fixed outside Theme 9 without losing the trail:

- **`P3-INTEG-1` — Uploadcare widget-side failures invisible to ops.**
  CDN/widget JS failure → patient sees generic "no files" error; no server
  signal. Fix: client-side global error listener that POSTs to a
  `/api/v1/integration-error?source=uploadcare` endpoint. ~50 lines. Not
  launch-blocking.

- **`P3-INTEG-2` — R2 runtime failures don't tag `error_logs.category`.**
  Surface as `category=NULL` rows next to generic uncaught errors. The
  existing partial index on category is unusable for R2 monitoring. Fix:
  thread `category='r2_storage'` through the put/get/delete catch blocks.
  ~10 lines.

- **`P3-INTEG-3` — `error_logs.category` is set by only three writers
  (whatsapp_send, email_send, admin_audit per audit P0-ERR-5).** Migration
  035's partial index is unused. Closing this gap is a cross-cutting
  follow-up: add a `category` param to `logErrorToDb()` and audit the 30+
  call sites. Out of scope for Theme 9; flagging for tracking.

- **`P3-INTEG-4` — `critical-alert.js` throttle counter resets on every
  `process.exit(1)`** (audit P1-NOTIF/ERR-P1). Sub-issue B's rewrite does
  not fix this — moving the throttle to a DB row needs a small migration
  and is its own change. Defer.

- **`P3-INTEG-5` — `WHATSAPP_API_VERSION` hardcoded in two modules** (audit
  P1-INT-19). Could fold into Sub-issue B; OQ-7 above.

- **`P3-INTEG-6` — Twilio Verify cleartext OTP fallback** (audit P1-INT-9).
  Out of theme; documented elsewhere.

- **`P3-INTEG-7` — IG `pingOps()` uses localhost:PORT** (audit P3-INT-39).
  Breaks on multi-instance deploys. Sub-issue E's scheduler change touches
  this file and is a natural place to fix it; but multi-instance is not
  the day-1 deploy topology, so deferring.
