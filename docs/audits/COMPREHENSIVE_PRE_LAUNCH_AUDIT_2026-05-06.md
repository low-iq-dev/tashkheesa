# Comprehensive Pre-Launch Audit — Tashkheesa Portal

**Date:** 2026-05-06
**Auditor:** Claude Opus 4.7 (1M context), interactive
**Working tree HEAD:** `d01d8b5` (`d01d8b524a76914fd26be9d8dd346284c2d3de7c` — "fix(csp): use <%- (raw) for inline nonce attribute fragments in patient_order + patient_payment_success")
**Branch:** `main`
**Methodology:** 11 parallel investigation agents, each scoped to one category (routes / views / security / state machine / integrations / workers / errors-obs / data layer / UI-UX / performance / config-deploy). Static code review across all 35 route files (~23,000 LoC), 154 EJS views, 43 migrations, every worker / cron / interval, every middleware, every external integration. No production curl probes — every claim is **VERIFIED-code** unless tagged otherwise.

---

## Why this audit exists

The prior audit (`docs/audits/PRE_LAUNCH_AUDIT_2026-04-30.md`) enumerated flow-level gaps (Paymob webhook CSRF, doctor earnings ledger unwired, etc.) but missed the foundational implementation bugs that surfaced during real usage in early May:

- CSP nonce HTML-escape (`<%= __nonceAttr %>` should have been `<%-`) — broke ALL inline scripts on `patient_new_case`
- Env var case mismatch (`Uploadcare_public_key` vs `UPLOADCARE_PUBLIC_KEY`) — silently dead uploader for weeks
- EJS partial scope dropping `cspNonce` on `foot.ejs` include
- pg pool saturation under SLA sweep load — sweep occasionally times out
- WhatsApp Cloud API token expired in production — silent 401s in logs, no alert
- `patient_new_case.ejs` validation crashes on render
- Schema drift (P3-DRIFT-1 patterns)
- Standalone uploader returning `?error=missing` on valid POSTs

This audit is full-stack and assumes nothing works until proven by reading the code. Across 11 categories, **523 distinct findings** were recorded, including **65 P0** items.

---

## Coverage

| Section | File | Findings | P0 | Notable |
|---|---|---:|---:|---|
| 01 Routes | `01-routes.md` | 35 | 4 | 368 route definitions across 35 files |
| 02 Views | `02-views.md` | 75 | 15 | 154 .ejs files; 17 .bak debt files |
| 03 Security | `03-security.md` | 64 | 0 (24 P1, several P0-equivalent) | Helmet+strict CSP both ship; one stored XSS |
| 04 State machine | `04-state-machine.md` | 25 | 4 | Two parallel lifecycles; 3 SLA breach sites |
| 05 Integrations | `05-integrations.md` | 50 | 9 | Resend / Paymob / WhatsApp / R2 env drift |
| 06 Workers | `06-workers.md` | 50 | 10 | 4 SLA breach implementations co-existing |
| 07 Errors / obs | `07-errors-obs.md` | 47 | 6 | patient.js + doctor.js + superadmin.js never call logErrorToDb |
| 08 Data layer | `08-data-layer.md` | 60 | 5 | 23 columns + 4 tables added by boot path outside migrations |
| 09 UI / UX | `09-ui-ux.md` | 63 | 3 | 33/122 user-facing views (27%) zero i18n; AR locale dead-loaded |
| 10 Performance | `10-performance.md` | 25 | 3 | pool max=10, no statement_timeout |
| 11 Config / deploy | `11-config-deploy.md` | 29 | 6 | 28 env vars in code missing from .env.example |
| **TOTAL** | | **~523** | **~65** | |

P0 = launch blocker (silent data loss, security breach, payment failure, page totally broken). P1 = visible breakage in golden flow. P2 = non-golden-path bug. P3 = cosmetic / debt.

---

## TOP LAUNCH BLOCKERS (P0) — actually fix these before any user traffic

Hand-picked across the 11 categories, deduplicated, ordered by blast radius. Each links to the detailed finding in the relevant section below.

### Tier 1 — schema drift & boot race (immediate breakage on first cold start)

1. **server.js:461 — `migrateForMobileApi(pool)` is called WITHOUT `await`.** Express begins accepting traffic before boot-path schema mutations finish. Cold-start race on every Render deploy. → DATA-3
2. **`migrate_mobile_api.js` re-adds `orders.urgent` column that migration 010 dropped.** Drift recurs every boot; whoever wrote the migration history did so under the assumption boot path wouldn't undo it. → DATA-1
3. **`routes/api/cases.js` SELECTs from `payments` table that migration 042 DROPS** (and which boot path then re-creates). Mobile case-detail will 500 after the next deploy. → DATA-2
4. **Soft-delete (`deleted_at IS NULL`) filter missing in essentially every order query** — patient/superadmin/payments/doctor.js have zero matches. Deleted orders leak into dashboards, SLA watchers, broadcasts, finance reports. → DATA-4
5. **`order_timeline` table exists only via the boot path; no migration codifies it; routes write to it.** Fresh DB without boot path = crashes. → DATA-5

### Tier 2 — view-render crashes & dead inline scripts (page totally broken)

6. **`video_appointment.ejs` calls `dayjs(...)` 10× server-side but no `res.render` site passes `dayjs` as a local.** Every render of book/pay/view/reschedule throws ReferenceError. Entire video-consultation flow is dead. → VIEW-P0
7. **6 inline `<script>` tags shipping without CSP nonce** (silently CSP-rejected): `services` (via `partials/service_assistant.ejs:225`), `help_me_choose.ejs:106`, `doctor_signup.ejs:363`, `video_appointment.ejs:197`, `patient_walkthrough.ejs:783`, `ops-dashboard.ejs:391`. Each kills primary functionality on its page. → VIEW-P0
8. **5 inline `onclick` / `onkeydown` / `href="javascript:..."` attributes blocked by CSP**: homepage language toggle (`index.ejs:82-83`), messages reopen button (`messages.ejs:128`), `ops-errors.ejs:77` clickable rows, 3 ops-error-detail buttons, `partials/patient/error-state.ejs:31` retry, `error.ejs:32` Go Back, `patient_prescription_detail.ejs:58` Print. → VIEW-P0
9. **17 patient-portal views include `partials/patient/foot.ejs` without explicit `cspNonce` pass-through** — same EJS-3 `with`-scope leak as the patient_new_case.ejs bug fixed in commit `e0f0183`. Latent: any EJS upgrade or strict-mode flip will break all 17 pages at once. → VIEW-P2 (treat as P0 risk)
10. **3 admin views use `nonce="<%= cspNonce %>"` with no typeof guard** (`admin_pricing.ejs:148`, `admin_campaign_new.ejs:81`, `admin_campaign_detail.ejs:131`) — latent ReferenceError. → VIEW-P0

### Tier 3 — CSRF / auth / public-surface holes

11. **`/api/cases/intake` (anonymous public website intake) is CSRF-blocked** — no exemption. Public intake currently 403s. → ROUTE-P0
12. **Marketing `fetch()` calls don't send `x-csrf-token`** because the cookie is `httpOnly` and the client can't read it: `/api/help-me-choose`, `/app/waitlist`, `/app/analytics`. → ROUTE-P0
13. **`POST /public/orders` creates patients/orders with no auth, no API key, no rate limit.** Mass-signup + DB pollution in seconds. → ROUTE-P0
14. **`/ops/agent/ping` and `/ops/agent/log-tokens` are CSRF-exempt AND auth-exempt** — anyone on the internet writes rows into `agent_heartbeats`/`agent_token_log` and forges token-spend telemetry. → SEC-P1 / ROUTE-P0
15. **`/order/:orderId/upload` family checks ownership only when `req.user` is set** — anonymous PHI exposure on UUID guess. → ROUTE-P1 (P0 risk)

### Tier 4 — config / env-var "silently dead service" class (foundational bug recurrence)

16. **`RESEND_API_KEY` is the email transport but undocumented in `.env.example`.** The entire SMTP block in `.env.example` is dead doc — code uses Resend (per `emailService.js:15` migration note). Deployer follows docs, sets SMTP, email goes silently dark with no boot warning. **Same pattern as the Uploadcare bug.** → CONF-P0
17. **`PAYMOB_LIVE_PAYMENTS` (undocumented) flips UI to live mode, but `paymob.js:_assertTestMode()` hard-throws unless `PAYMOB_MODE=test`.** UI says live, backend 502s every intention. → CONF-P0 / INT-P0
18. **`SESSION_SECRET` is an undocumented JWT_SECRET fallback** (`requireJWT.js:13`). server.js:52 fatal-checks only `JWT_SECRET`. Deployer setting `SESSION_SECRET` per Express convention will boot with no JWT secret and crash on first login. → CONF-P0
19. **R2 env vars (4) all missing from `.env.example`** — every doctor file download 500s if any unset. → INT-P0
20. **Boot validator only checks 3 env vars** (JWT_SECRET, DATABASE_URL, ANTHROPIC_API_KEY). 14+ production-required vars (Resend, Uploadcare, all Paymob, all Twilio, WhatsApp tokens, encryption key, OPS creds) silently degrade on missing. → CONF-P0
21. **`UPLOADCARE_PUBLIC_KEY || UPLOADCARE_PUBLIC || UPLOADCARE_KEY` alias chain only exists in `verify.js`** — patient.js reads canonical name only. The original mismatch bug pattern is one rename away from recurring. → CONF-P0
22. **`MODE` vs `NODE_ENV` inconsistency: 8 sites diverge.** Three router files (campaigns, tash-api, public_orders) gate dev routes on `NODE_ENV === 'production'`. If `MODE=production` but `NODE_ENV` unset, dev routes are live in production. → CONF-P0

### Tier 5 — pool saturation (root cause of SLA flakiness)

23. **`markCasePaid` in `case_lifecycle.js:1331-1396` holds a `SELECT FOR UPDATE` inside `withTransaction`, but every helper inside (`transitionCase`, `logCaseEvent`, `execute(UPDATE notifications)`, `triggerNotification`, `dispatchSlaReminders`, `getCase`) ignores the `client` arg and re-acquires from the module-level pool.** With `max=10`, two concurrent payments saturate the pool. **Root cause of the SLA-sweep flakiness symptom.** → PERF-P0
24. **No `statement_timeout`, no `query_timeout`** on PG pool. The recent `connectionTimeoutMillis 5s→15s` raise masks this. A slow query (e.g. the `LIKE '%request%'` CTE in `superadmin.js:914-960` over `order_events`) holds a slot indefinitely. → PERF-P0
25. **server.js:1035-1098 (`runSlaReminderJob`) repeats the same recursive-pool-acquire pattern as P0-PERF-1** — txn client held through a `for` loop with `queueNotification` calls bypassing the txn client + an `issueBreachRefundSafe` HTTP call. → PERF-P0
26. **pg-boss `DATABASE_URL_DIRECT` falls back to `DATABASE_URL` (the pgbouncer pooled URL)** — silently shares the request pool if the env is misconfigured. → PERF-P0

### Tier 6 — workers / single-writer

27. **Notification worker runs on every Render instance** (`server.js:967-974`) — no `SLA_MODE=primary` gate, no row-level claim. On a 2-instance Render plan, every notification ships **2x** on day 1. **Same bug for conversation auto-close** (`server.js:910`). → WORKER-P0
28. **`case_sla_worker.js:413` — `setInterval(() => { try { runCaseSlaSweep() } catch })`** — try/catch is sync, async rejections escape and trip server.js:195's `process.exit(1)` guard. The in-process SLA fallback path crashes the server on any transient DB failure. → WORKER-P0
29. **`video_scheduler.sweepStalePendingSlots` uses `userId:` instead of `toUserId:`** (line 253). 24h/48h video-slot stale notifications silently dropped — auto-cancel + refund happens, patient is never told. → WORKER-P0
30. **Campaigns cron `var ci` hoisting bug** (`server.js:932-953`) — `setImmediate(() => processCampaign(scheduled[ci].id))` captures the loop variable; `ci` is `scheduled.length` at fire time, calls `processCampaign(undefined)`. Approved campaigns get UPDATE'd to 'sending' and stay there forever. → WORKER-P0
31. **Three independent SLA breach implementations co-exist** — `case_sla_worker`, `sla_watcher`, and `superadmin.performSlaCheck` — all write 'breached' in parallel. Duplicate breach events + duplicate notifications. → WORKER-P0 / STATE-P0
32. **Pool starvation analogues of the foundational bug** in `case_lifecycle.dispatchUnpaidCaseReminders:457-504` and `sla_watcher.runSlaSweep:115-216` — both hold `withTransaction` clients while calling `pool.query` inside the loop. → WORKER-P0
33. **`pg-boss SLA singleton fallback race`** (`server.js:880-884`): if the in-process fallback fires while a previously-persisted pg-boss schedule is still alive, both run. → WORKER-P0
34. **Event-triggered SLA sweep** (`server.js:643`) fires on every non-GET 2xx mutation with only an in-process JS boolean as guard — fans into the same pool as the 5-min interval. → WORKER-P0

### Tier 7 — state machine bypasses (canonical lifecycle defeated)

35. **Doctor accept handler** (`doctor.js:1942`) bypasses canonical `transitionCase`, writes lowercase `'in_review'` directly. → STATE-P0
36. **Three SLA-breach paths** write non-canonical `'breached'` in parallel (server.js, sla_watcher.js, superadmin performSlaCheck) — no event log, no notification dedupe. → STATE-P0
37. **No patient-cancel-with-refund flow exists in the portal** — only the mobile API has one. Patients who want to cancel can't from the web. Superadmin cancel never issues a refund. → STATE-P0
38. **`awaiting_files` is written by superadmin but is absent from the canonical enum / UI / transition table.** Cases stuck in unrenderable status. → STATE-P0

### Tier 8 — silent ops blindness (you won't even know what's breaking)

39. **`routes/patient.js` (3,600 LoC, 16 catch sites), `doctor.js`, `superadmin.js` never call `logErrorToDb`.** Wizard, upload, dashboard, payment, message errors only hit Render stdout, not /ops/errors. Highest-traffic surfaces are blind. → ERR-P0
40. **`error_logs.category` populated by only 3 callers** (admin_audit, email, whatsapp). Migration 035's index is unused; /ops/errors filtering by category yields 0 rows for ~99% of writes. → ERR-P0
41. **`notify.js queueNotification` insert failure swallowed; ~50 callers fire-and-forget.** Patient sees "case received" / "files uploaded" while no email/WhatsApp/in-app notif ever queued. → ERR-P0
42. **`patient_500.ejs` includes patient/head + foot partials that depend on `cspNonce`; not explicitly passed by the global error handler render call.** Crash → render → secondary crash spiral. → ERR-P0
43. **`?error=reason_required` is silent** — redirect at `doctor.js:2126` is never read by the GET handler at `doctor.js:1526-1535` (only `req.query.msg` is). Doctor sees the reject-files form do nothing. → ERR-P0
44. **`logFatal` is just `console.error`** — no DB write, no critical-alert. SLA breach handling failures (case_sla_worker.js:351,361,371,379,417) hit only stdout. → ERR-P0
45. **Async setInterval pattern across multiple workers** — `setInterval(() => { try { runAsyncFn() } catch {} })` cannot catch async rejections. `case_sla_worker.js:393` deliberately rethrows on transient pool errors → unhandledRejection → process.exit(1). → ERR-P0

### Tier 9 — silent third-party degradation

46. **WhatsApp 401 silent in `notify/whatsapp.js:135`** — exact foundational bug recurs. critical-alert.js itself broken (uses `type:'text'` outside Meta's 24h re-engagement window; envs captured at module-load so token rotation needs a server restart). No alert ever fires. → INT-P0
47. **Doctor video consults bookable + chargeable when `VIDEO_CONSULTATION_ENABLED=false`.** Only `/api/video/token` returns 503; booking and Paymob webhook all run. Patient pays, can never join. → INT-P0
48. **Paymob hard-gated to test mode** (`services/paymob.js:39-46`) — code physically refuses live payments. Switching `PAYMOB_MODE=live` returns 502 from every checkout. → INT-P0
49. **Hardcoded stale Anthropic models** — `claude-sonnet-4-20250514` in three files, `claude-haiku-4-5` in one. No env override, no prompt caching. → INT-P1 (treat as P0 cost risk)
50. **Instagram token refresh broken three ways** (`scheduler.js:121`) — never scheduled, never persisted, never propagated to publisher. 60-day expiry hits silently. → INT-P0

### Tier 10 — security (latent but exploitable)

51. **One stored XSS** — `views/admin.ejs:335` raw-renders the doctor's self-supplied name (`<%- o.doctor_name %>`). Mitigated only by the strict CSP holding. → SEC-P1
52. **Same `JWT_SECRET` signs portal session cookies, mobile access tokens, mobile refresh tokens, and ops cookies.** Eliminates security boundary — stolen cookie ≠ stolen API token doesn't hold. → SEC-P1
53. **Helmet's CSP (with `'unsafe-inline'`) AND the strict per-request nonce CSP both ship**; the second overwrites via `setHeader`. One refactor away from a free XSS regression. → SEC-P1
54. **Helmet CSP also drops Twilio's `wss://*.twilio.com` from `connect-src`** — breaking video calls when the strict CSP is regressed. → SEC-P1
55. **Portal session is a flat 7-day JWT with no rotation, no refresh, no revocation list.** `POST /logout` only clears the cookie — a stolen value remains valid for 7 days. → SEC-P1
56. **Password reset is non-atomic check-then-mark** (race window). Mobile login is missing the `is_active` check. → SEC-P1
57. **No per-identity login throttling — only per-IP**. `LOGIN_ATTEMPTS` for ops is per-process in-memory, trivially bypassed on multi-instance Render. → SEC-P1
58. **`/api/v1/auth/otp/request` has no per-phone rate limit** — Twilio Verify spend pump. → SEC-P1
59. **`/api/help-me-choose` (20/IP/min, unauthenticated)** — Anthropic API spend pump. → SEC-P1
60. **`users.refresh_token` stored in plaintext** — DB read = 30-day mobile session hijack. → SEC-P1
61. **`/files/:fileId` 302-redirects to R2 signed URL** — full URL with signed creds lands in browser history. → SEC-P2 (treat as P0 PHI risk)

### Tier 11 — UI / launch readiness in Arabic

62. **27% of user-facing views (33/122) have ZERO i18n** — including the homepage `index.ejs`, `about`, `services`, `contact`, `coming_soon`, all 4 legal pages, `404`, `error`. → UI-P0
63. **`coming_soon.ejs` is currently the destination of `/order/start`** (per `order_flow.js:115-119`) and is English-only — meaning **no AR-speaking patient can complete an order today**. → UI-P0
64. **`messages.ejs:49` shows "Your conversations with patients" on the patient branch** (literally wrong copy in both EN and AR). → UI-P1
65. **`locales/ar.json` has 68 keys not in `en.json`. Both JSON files are loaded but never consumed by views** — `getTranslator` is never called from middleware/routes. Two parallel i18n systems, one dead. → UI-P0

---

## TOP P1 — visible breakage in golden flow (fix before scale)

(Condensed; see per-section detail.)

- **DATA-9** Migration 033 RE-INSERTS `spec-pathology` that 018 deleted; **DATA-10** `addons_json` declared TEXT but used as JSONB; **DATA-11** TIMESTAMP vs TIMESTAMPTZ drift on orders; **DATA-12** dual-schema `notifications` table; **DATA-19** legacy `cases` table still actively written by intake; **DATA-22** seedPricingData early-exits if any rows exist; **DATA-24** runDataFixups overrides admin specialty edits on every boot; **DATA-17 / 18** orders.base_price + urgency_uplift_amount unbackfilled for legacy orders, breaking refund math.
- **STATE-P1 (×11)** Superadmin mark-paid bypasses `markCasePaid`; superadmin reassign bypasses `reassignCase` (orphans original doctor's earnings); doctor reject-files bypasses `markOrderRejectedFiles` (SLA keeps ticking); `resumeSla` exported but never called; SLA sweeps don't filter `deleted_at IS NULL`; `markSlaBreach` only allows from `IN_REVIEW`; auto-assign races broadcast acceptance; report-completion uses raw UPDATE never closing `doctor_assignments.completed_at`; `payment_status='refunded'` writes nothing to `refunds`; webhook splits payment_status UPDATE from `markCasePaid` transaction.
- **WORKER-P1 (×17)** IG access token expires 60d, `refreshToken()` exists but never invoked; `superadmin-1` hardcoded as recipient in acceptance_watcher and notify.js; TZ bugs (`sla_watcher`, `runSlaReminderJob`, `appointment_reminders` use parameterized ISO-Z without Cairo conversion — drift of ~3h); no `.unref()` on most intervals; no `worker_runs` heartbeat table; pg-boss handler errors console-only.
- **VIEW-P1 (×10)** Doctor-dashboard welcome-dismiss fetch lacks x-csrf-token; 4 dead views still on disk reference undeclared locals; 21 sites with `target="_blank"` lacking `rel="noopener noreferrer"`; `_app_waitlist_form.ejs` form has no method/action/CSRF; `messages.ejs` patients render legacy sidebar instead of v2; `appointment_availability.ejs` has bare `csrfField()` and never closes layout; `register.ejs` / `intake_form.ejs` / `superadmin_order_new.ejs` reference `error` without typeof guard; `admin_doctors.ejs` superadmin path omits `stats`/`recentActivity`.
- **SEC-P1 (×24)** including stored-XSS in admin.ejs:335 (doctor name unescaped); helmet+strict CSP duplicate emit; `RESEND_API_KEY` undocumented; refresh tokens plaintext; `/files/:fileId` signed URL leak via 302; `notification_worker.js` DRY_RUN logs email + phone plaintext; `services/twilio_verify.js` logs full phone on every call; `routes/static-pages.js` logs contact-form name+email plaintext; `src/create_test_doctor.js` committed seed with hardcoded password that runs UPDATE-if-exists; no HSTS anywhere; no HTTP→HTTPS redirect.
- **ERR-P1** critical-alert throttle is per-process and reset by `process.exit` — every crash sends a WhatsApp; flap-loops burn through Meta rate limits. WhatsApp critical-alert delivery is itself unobserved (every error swallowed); broken token = silent. Render logs unstructured; req-id only on access lines, not on downstream worker/log lines. `?error=invalid_url` covers two distinct failure modes (URL regex vs DB transaction failure) — wrong UX for outage. Patient `?msg=no_doctor` redirect (`patient.js:2777`) never read by view. `?failed=1` (patient.js:1708) — view doesn't render it.
- **UI-P1** `appointment_detail.ejs` is hardcoded English and uses untranslatable `prompt()` / `alert()`; 17+ inline `border-left:` styles on patient list intro cards won't flip in RTL; register/intake/contact forms don't disable on submit and don't translate server error strings; `coming_soon.ejs` form labels aren't `for`/`id`-paired; phone field has no country-code picker or E.164 normalization; admin tables overflow on mobile.
- **PERF-P1** `/api/help-me-choose` runs serial Anthropic calls inside a request handler (`order_flow.js:308-370`); `routes/exports.js:16-39` materializes the full orders table with no LIMIT/streaming; `superadmin.js:914-960` `LIKE '%request%'` CTE over `order_events` has no index match; static middleware has no maxAge / setHeaders / compression(); five public images >1 MB on homepage.
- **CONF-P1** `BASIC_AUTH_USER || STAGING_USER` (STAGING_* both undocumented); `BASE_URL || APP_URL` aliasing in 3 sites without warning; demo seed gate correct but `SEED_DEMO_DATA` flag itself undocumented; no render.yaml / Dockerfile / Procfile / app.json — all Render config dashboard-only.
- **INT-P1 (×16)** including: OTPs stored cleartext in `otp_codes` even when Twilio Verify configured (defeats Verify); Twilio API key/secret silently fall back to ACCOUNT_SID/AUTH_TOKEN exposing master credential in JWT; `pg.js` uses `rejectUnauthorized: false` (TLS cert never validated); `/ops/agent/*` shells out via string-concatenated SSH.

---

## Recommended fix order (week-by-week minimum to launch)

**Pre-launch week 1 (mandatory):**

1. **Schema drift** — fix Tier 1 (1–5). Make `migrate_mobile_api` idempotent OR await it. Backfill `deleted_at IS NULL` filter as a SQL helper everywhere. (~1 day)
2. **CSP / view crash** — fix Tier 2 (6–10). dayjs local pass; nonce on 6 inline scripts; CSP-safe alternatives for 5 onclick handlers; explicit `cspNonce` thread to `partials/patient/foot.ejs` from all 17 callers. (~1 day)
3. **CSRF / public surface** — fix Tier 3 (11–15). `/api/cases/intake` exemption + signature verification; CSRF token in fetch headers via meta tag; rate-limit `/public/orders`; auth-gate `/ops/agent/*`. (~0.5 day)
4. **Env var docs + boot validation** — fix Tier 4 (16–22). Document every var. Add boot-time validation for all production-required vars. Remove dead SMTP doc. (~0.5 day)
5. **Pool saturation root cause** — fix Tier 5 (23–26). Thread `client` through `markCasePaid` helpers; set `statement_timeout=30000`; verify `DATABASE_URL_DIRECT` is configured. (~1 day)

**Pre-launch week 2 (high-priority):**

6. **Workers single-writer** — fix Tier 6 (27–34). Gate notification worker + conversation auto-close on `SLA_MODE=primary`. Wrap setInterval bodies in `(async () => { try { ... } catch (e) { logErrorToDb(...) } })()`. Fix `var ci` → `let ci`. Fix `userId:` → `toUserId:` in video scheduler. (~1 day)
7. **State machine bypasses** — fix Tier 7 (35–38). Route doctor-accept and superadmin-mutations through canonical `transitionCase`/`reassignCase`. Add patient-cancel-with-refund. Either codify or remove `awaiting_files`. (~1 day)
8. **Ops blindness** — fix Tier 8 (39–45). Wrap every catch in patient.js/doctor.js/superadmin.js with `logErrorToDb`. Populate `error_logs.category`. Fix `?error=` codes that views ignore. (~1 day)

**Pre-launch week 3 (security + UX):**

9. **Security hardening** — fix Tier 10 (51–61). Escape doctor_name in admin.ejs. Add HSTS. Stop logging PII. Add per-phone OTP rate limit. (~1 day)
10. **Arabic readiness** — fix Tier 11 (62–65). Translate the 33 user-facing English-only views, or block AR locale switch on those routes with a "coming soon" banner. (~1–2 days)

---

## How to use this document

- Sections 01–11 below are the verbatim outputs of each parallel investigation agent. Each section starts with its own inventory tables and then lists findings in the format `### [SEVERITY]-CATEGORY-N — title`.
- Cross-references between sections use the agent's local IDs (e.g. `DATA-3`, `WORKER-P0`).
- "VERIFIED-code" = read directly in the source. "INFERRED" = reasoned from code without runtime exercise. "NEEDS-VERIFICATION" = requires a manual check (e.g. Render dashboard, production curl, runtime tracing).

---

# Section 01 — Routes inventory + handler audit

# Routes Audit — 2026-05-06

Scope: src/routes/*.js (35 files) + src/server.js mounts. Method: enumerated via grep, then targeted reads. Severity per AUDIT_GROUND_RULES.

## Inventory

- Definitions: 368 `router.<verb>(...)` lines across 35 route files (incl. 7 in src/routes/api/, 16 in src/instagram/routes.js).
- Methods (full app): GET ~155, POST ~135, PUT 3, PATCH 4, DELETE 6.
- Mount table (src/server.js):
  - `/site, /assets, /js, /css, /vendor, /uploads, /styles.css, /favicon.*, /annotator.html` → static
  - `/` → health, verify, static-pages, lang, aiAssistant, auth, doctor, patient, superadmin, exports, admin, public, publicOrders, intake, orderFlow, video, addons, appointments, annotations, analytics, reports, reviews, onboarding, messaging, prescriptions, tashApi, medicalRecords, referrals, campaigns, help, appLanding (line 651–678)
  - `/payments` → paymentRoutes (line 662)
  - `/ops` → opsRoutes (679)
  - `/api/admin/instagram` → requireRole('superadmin') + instagramRoutes (680)
  - `/internal/run-sla-check`, `/internal/run-sla-enforcement` → ad-hoc gated by `requireOpsRole` (lines 690, 698)
  - `/api/v1` → apiV1 (724)
  - `/api/cases` → cases_intake (727)
- Body parsers: global `express.json({limit:'1mb'})` + `express.urlencoded({extended:true,limit:'1mb'})` in `src/middleware.js:73-74`. Re-applied locally with bigger limits in `payments.js`, `api_v1.js`, `api/cases_intake.js`.
- CSRF (src/middleware/csrf.js): enforce in production/staging. EXEMPT_PATHS=`/health, /status, /healthz, /__version`. Path-based bypasses: assets, `/api/v1/*`, `/callback`, `/portal/video/payment/callback*`, `/payments/callback*`, `/ops/agent/*`, `/ops/login`, `/ops/errors/*`. Cookie `csrf_token` is httpOnly; token must be echoed via `x-csrf-token` header or `_csrf` body field.
- Webhook auth: HMAC via `verifyPaymobHmac` on `POST /payments/callback` and `POST /portal/video/payment/callback`.
- Mobile API: JWT (`requireJWT` + `requireRole('patient')`) on `/api/v1/*` except `/auth/*` and `/health`.
- File uploads: `multer.memoryStorage`, 50 MB cap, ext+MIME allowlist, dangerous-ext blocklist (`src/middleware/upload.js`). Used by `order_flow.js` (`upload.array('files')`), `prescriptions.js` (`upload.single('prescription_file')`), `doctor.js` photo+signature.

---

## Findings

### P0-ROUTE-1 — `/api/cases/intake` is CSRF-blocked despite being marketing-site anonymous endpoint
**Severity:** P0 | **Category:** routes/contract | **Location:** src/routes/api/cases_intake.js:36 + src/middleware/csrf.js:67-99 | **Description:** Mounted at `/api/cases` (server.js:727). Path `/api/cases/intake` is not in any CSRF exemption (`/api/v1/*` is, `/api/cases/*` is not). Handler is documented "Anonymous (no auth)" and is the production endpoint for the marketing landing page that posts patient case intake. In `enforce` mode (production/staging) the CSRF middleware will 403 every server-to-server or cross-origin POST that lacks the cookie+token round-trip. Same-origin browsers that first GET a page on `tashkheesa.com` will have a `csrf_token` cookie set, but they must read the (httpOnly) cookie value somehow — the form would have to be EJS-rendered with `csrfField()` injected, which a static marketing site cannot do. **Impact:** Public intake form 403s in production; lead capture broken. **Fix scope:** small (add `p.startsWith('/api/cases/')` to csrf bypass list and rely on the dedicated rate-limiter, OR exempt only `/api/cases/intake`). **Verification:** VERIFIED-code (csrf.js exemption set; cases_intake.js lacks any token check; mount at /api/cases is global).

### P0-ROUTE-2 — Public website forms call `/api/help-me-choose`, `/app/waitlist`, `/app/analytics` without CSRF token → 403 in enforce mode
**Severity:** P0 | **Category:** routes/contract | **Location:** src/views/help_me_choose.ejs:137, src/views/partials/service_assistant.ejs:271, src/views/app_landing.ejs:171,228 vs src/routes/ai_assistant.js:89 + src/routes/app_landing.js:70,112 | **Description:** All three POST routes are CSRF-enforced (no exemption). The client-side `fetch()` calls in the views explicitly send only `Content-Type: application/json` — no `x-csrf-token` header, no `_csrf` body field. Same-origin cookie is httpOnly so JS can't read it; only `coming_soon.ejs` and `patient_payment_required.ejs` correctly server-render `<%= csrfToken %>` into a JS variable. **Impact:** "Help Me Choose" assistant chat returns 403; app waitlist + click analytics drop on every visitor in production. **Fix scope:** small — add `<%= typeof csrfToken !== 'undefined' ? csrfToken : '' %>` into each view and pass as `x-csrf-token` header (mirror `coming_soon.ejs:372-375`). **Verification:** VERIFIED-code.

### P0-ROUTE-3 — `POST /public/orders` creates patient + order without auth, CSRF, or API key
**Severity:** P0 | **Category:** security | **Location:** src/routes/public.js:8-147 | **Description:** Mounted at `/` (server.js:658). No `requireRole`, no API key, no rate limit specifically for this path (only the global 100/min). CSRF blocks browser cross-site, but a server with no cookie can simply not send one — there's no validation. Body fields control `patient_email/name/phone`, `service_id`, `sla_type` and the route happily inserts a `users` row + an `orders` row + queues notifications. **Impact:** Spam patient and order creation; user-row enumeration via duplicate-email path; notification flood. The neighbor route `POST /api/public/orders` (public_orders.js:45-185) already enforces `PUBLIC_ORDER_API_KEY` with `timingSafeEqual`. This route appears to be a duplicate from before that gate was added. **Fix scope:** small — either delete `/public/orders` (no view in the repo references it) or add the same API-key check used by `/api/public/orders`. **Verification:** VERIFIED-code (no auth middleware in handler).

### P0-ROUTE-4 — `POST /ops/agent/ping` and `/ops/agent/log-tokens` are CSRF-exempt and have NO auth
**Severity:** P0 | **Category:** security | **Location:** src/routes/ops.js:655-708 + src/middleware/csrf.js:86-87 | **Description:** csrf.js exempts `p.startsWith('/ops/agent/')` and the two routes are missing `requireOpsAuth`. Anyone on the internet can POST arbitrary `agent_name`, `current_task`, `token_cost_usd`, `tokens_used`, `cost_usd`, `task_label` (capped at 200/500/2000 chars) to insert rows into `agent_heartbeats` and `agent_token_log`. The other agent routes (`/agent/toggle`, `/agent/cleanup`) are gated; only ping + log-tokens are open. **Impact:** Unauthenticated DB-row injection / disk-fill, and pollution of ops dashboard. **Fix scope:** small — add a shared-secret header check (env `OPS_AGENT_KEY`) in both handlers; the agents are already server-side so a header is trivial to set. **Verification:** VERIFIED-code.

### P1-ROUTE-5 — `GET /order/:orderId/upload` exposes order PHI to anonymous visitors who guess the UUID
**Severity:** P1 | **Category:** security | **Location:** src/routes/order_flow.js:133-165 | **Description:** No `requireAuth`/`requireRole`. Ownership check only fires when `req.user` is set: `if (req.user && req.user.role === 'patient' && order.patient_id && ...) return 403`. An unauthenticated client passes through and gets the rendered `order_upload` view including `existingFiles` URLs (often Uploadcare links to PHI). The `/order/start` parent flow currently redirects to `coming_soon.ejs` (order_flow.js:115) so the route is effectively dormant, but it remains mounted and reachable by anyone with an order id. UUIDs are not guessable but order ids leak via webhooks, emails, and admin screens. **Impact:** PHI exposure on any leaked order id; pre-launch state masks but does not remove the bug. **Fix scope:** small — add `requireAuth()` (or remove the route since `/order/start` is gated). Also applies to `POST /order/:orderId/review`, `/order/:orderId/payment`, `/order/:orderId/urgency-conflict`, `/order/:orderId/urgency-resolve`, `/order/:orderId/confirmation` which share the same pattern. **Verification:** VERIFIED-code.

### P1-ROUTE-6 — `/api/v1/auth/me` is mounted before `requireJWT` — relies on global `attachUser` Bearer parsing only
**Severity:** P1 | **Category:** contract | **Location:** src/routes/api_v1.js:71 (mount) + 81 (requireJWT applied AFTER) + src/routes/api/auth.js:289-294 | **Description:** `router.use('/auth', authLimiter, authRoutes)` is placed at line 71, while `router.use(requireJWT)` is at line 81. Result: `/api/v1/auth/me` does NOT pass through `requireJWT`. The handler manually checks `if (!req.user) return res.fail('Not authenticated', 401)`. `req.user` only gets populated by the global `attachUser` middleware in `src/auth.js:85-103`, which reads either `Authorization: Bearer …` or the portal session cookie — i.e. a stale or invalid bearer token will fail silently and the route returns 401 instead of the explicit `INVALID_TOKEN` / `EXPIRED_TOKEN` codes that `requireJWT` returns. The inline comment ("NOTE: This route needs requireJWT — mounted separately in api_v1.js") flags the intent but the mount never happens. **Impact:** Inconsistent auth error contract for the mobile app; missing token rotation guards for `/me`. **Fix scope:** small — wrap the `/me` GET with `requireJWT` directly in api/auth.js, or remount `/me` after the global requireJWT in api_v1.js. **Verification:** VERIFIED-code.

### P1-ROUTE-7 — Form `action="/case/new"` has no matching route handler
**Severity:** P1 | **Category:** contract | **Location:** src/views/public_case_new.ejs:66 vs src/routes/* | **Description:** No `router.<verb>('/case/new', ...)` exists anywhere. Form POSTs land in the global 404 handler (server.js:754). **Impact:** Broken submission on the marketing/legacy "Create New Case" page. **Fix scope:** small — either retire the view or implement the route. **Verification:** VERIFIED-code (grep across src/ found zero matches).

### P1-ROUTE-8 — `<form action="/order/upload" method="get">` points at a non-existent path
**Severity:** P1 | **Category:** contract | **Location:** src/views/order_start.ejs:18 | **Description:** Routes only define `/order/start` and `/order/:orderId/upload`. `/order/upload` is unmatched (would 404). **Impact:** Order-start CTA broken. **Fix scope:** small — change action to `/order/start`. **Verification:** VERIFIED-code.

### P1-ROUTE-9 — Mobile API `PATCH /api/v1/profile` accepts free-form `phone` without E.164 normalization
**Severity:** P1 | **Category:** contract | **Location:** src/routes/api/profile.js:37-73 | **Description:** `body('phone').optional().trim()` and the SQL update writes the raw value. The portal flows (`auth.js:579-614` for register, `api/auth.js:48-53` for register, `api/auth.js:253-260` for OTP login) all run `validatePhoneE164` to enforce the format that fixes the truncated-rows incident from P0-FORM-1. The profile patch is the one path that bypasses the validator. **Impact:** Re-introduces the 78%-no-phone / `+2010` truncated rows that P0-FORM-1 was created to eliminate; downstream WhatsApp lifecycle dispatch (P1-NOTIF-1) silently fails for any phone changed via mobile app. **Fix scope:** small — call `validatePhoneE164` and persist the normalized value (mirror api/auth.js register). **Verification:** VERIFIED-code.

### P1-ROUTE-10 — `PATCH /api/v1/profile/password` does not invalidate refresh tokens after password change
**Severity:** P1 | **Category:** security | **Location:** src/routes/api/profile.js:101-122 | **Description:** Updates `users.password_hash` but leaves `users.refresh_token` (set by login/register/refresh in api/auth.js) intact. A stolen refresh token continues to work after the user "changed password to log out attackers". **Impact:** Account takeover persists across password rotation. **Fix scope:** small — `UPDATE users SET refresh_token = NULL WHERE id = $1` in the same transaction. **Verification:** VERIFIED-code.

### P1-ROUTE-11 — `DELETE /api/v1/profile/account` deletes user-related rows piecemeal with `safeRun` swallowing errors → orphaned data on partial failure
**Severity:** P1 | **Category:** data integrity | **Location:** src/routes/api/profile.js:127-160 | **Description:** Iterates a hard-coded `tables` array and deletes via `safeRun`. Each delete is wrapped in try/catch that just `console.warn`s on error. There is no transaction. If `messages DELETE` succeeds but `orders DELETE` fails (FK violation, lock contention, etc.), GDPR deletion is partial — message-history is gone but the user + orders + PHI remain. The list also misses several FK-bearing tables (e.g., `appointment_payments`, `appointments`, `referral_redemptions`, `chat_reports`, `case_annotations`, `password_reset_tokens`, `app_waitlist`). **Impact:** Failed GDPR compliance + data corruption. **Fix scope:** medium — wrap in `withTransaction`, treat missing-table as the only catchable error, audit the table list against the live schema. **Verification:** VERIFIED-code.

### P1-ROUTE-12 — `POST /portal/video/payment/callback` does not insert a `payment_events` audit row on HMAC failure
**Severity:** P1 | **Category:** security/audit | **Location:** src/routes/video.js:288-296 vs src/routes/payments.js:209-237 | **Description:** The Paymob video callback rejects bad-HMAC requests with 401 but only writes `console.warn`. The sibling `/payments/callback` for case orders does insert `payment_events (event_type='hmac_failure', payload_json=…)` and fires `sendCriticalAlert`. Asymmetric audit means scanning attacks on the video webhook leave no trace. **Impact:** No on-call alert + no DB record for video payment webhook abuse. **Fix scope:** small — copy the audit + alert block from payments.js. **Verification:** VERIFIED-code.

### P1-ROUTE-13 — Server-to-server caller of `POST /api/public/orders` will be CSRF-blocked despite valid API key
**Severity:** P1 | **Category:** routes/contract | **Location:** src/routes/public_orders.js:45-185 + src/middleware/csrf.js | **Description:** Auth is by `api_key` field with `timingSafeEqual` — correct. But CSRF middleware runs before the handler and is not exempted for `/api/public/orders`. A first-time server-to-server POST has no `csrf_token` cookie and no token in body, so enforce mode rejects with 403 before the handler authenticates. **Impact:** Documented public-orders integration unusable in production from any non-browser client. **Fix scope:** small — add `/api/public/` to csrf exempt list (auth still enforced via API key). **Verification:** VERIFIED-code (csrf.js shows no /api/public exemption).

### P1-ROUTE-14 — Marketing site contact form (when posted via `public/js/site-form.js`) requires `data-csrf` attribute that no view sets
**Severity:** P1 | **Category:** contract | **Location:** public/js/site-form.js:111 + src/views/contact.ejs:35-63 | **Description:** site-form.js reads `form.getAttribute('data-csrf')` to populate the CSRF header. `contact.ejs` does NOT set `data-csrf` on the form (it uses `csrfField()` which only places a hidden `_csrf` input — fine for HTML form submit, but the JS reads only the attr). Currently contact form is a plain HTML POST so this works; but if the marketing site swaps to JS submit (or shares the script), it silently sends an empty CSRF header. **Impact:** Latent bug; contact-form 403 the day someone wires up site-form.js. **Fix scope:** small — render `data-csrf="<%= csrfToken %>"` on the `<form>` tag. **Verification:** VERIFIED-code (no `data-csrf` in contact.ejs).

### P2-ROUTE-15 — `tash-api.js` API-key comparison is `key !== TASH_API_KEY` (not constant-time)
**Severity:** P2 | **Category:** security | **Location:** src/routes/tash-api.js:17-23 | **Description:** Direct `!==` comparison leaks length and per-char info on a pure-JS string compare. Other API-key checks in this codebase (public_orders.js:52-55) use `crypto.timingSafeEqual`. **Impact:** Theoretical timing oracle on the read-only stats endpoint. **Fix scope:** small — adopt `timingSafeEqual` after equal-length guard. **Verification:** VERIFIED-code.

### P2-ROUTE-16 — `/superadmin/run-sla-check`, `/superadmin/tools/run-sla-check`, `/superadmin/tools/run-sla-sweep` are GET-mutating actions
**Severity:** P2 | **Category:** routes/security | **Location:** src/routes/superadmin.js:2796, 2806, 2822 | **Description:** All three trigger SLA enforcement sweeps but are `router.get(...)`. CSRF doesn't apply to GET; an attacker with an authenticated superadmin's logged-in browser can be tricked into hitting a `<img src="/superadmin/run-sla-check">` and the sweep fires. Same pattern on `/internal/run-sla-check` (server.js:690-696). **Impact:** State-mutating CSRF on superadmin via image tags / link previews. **Fix scope:** small — convert to POST with CSRF token, or add a confirmation GET → POST flow. **Verification:** VERIFIED-code (handler calls `runSlaEnforcementSweep`).

### P2-ROUTE-17 — `messaging.js` uses `res.redirect('back')` which is removed in Express 5 and discouraged in Express 4 due to spoofable `Referer`
**Severity:** P2 | **Category:** routes | **Location:** src/routes/messaging.js:461,484 | **Description:** Works on current Express 4.x but breaks on upgrade and follows whatever the client sends in `Referer`. Acceptable today but flag for the upgrade path. **Impact:** Future upgrade hazard; minor open-redirect via crafted Referer (browser-only). **Fix scope:** small — redirect to a known-safe absolute path. **Verification:** VERIFIED-code.

### P2-ROUTE-18 — `GET /portal/doctor/profile/photo/:id` and `/signature/:id` rely solely on `requireDoctor` not on ownership
**Severity:** P2 | **Category:** security | **Location:** src/routes/doctor.js:2695, 2811 | **Description:** Any logged-in doctor can fetch any other doctor's profile photo / signature by id (they're stored as R2 keys and the URL maps a numeric id). Profile photos are not strictly PHI, but signatures are used to authenticate prescriptions and should not leak between doctors. (Did not read full handler — flagging based on route + auth signature.) **Impact:** Cross-doctor signature image leak. **Fix scope:** small — verify `req.user.id` matches `users.id` for the requested record before serving. **Verification:** INFERRED (route definition only; full body read recommended).

### P2-ROUTE-19 — `POST /portal/doctor/profile/photo` and `/signature` POST routes have no rate limit beyond the 100/min global
**Severity:** P2 | **Category:** abuse | **Location:** src/routes/doctor.js:2606, 2732 | **Description:** Each call uploads a 5–50 MB buffer to R2 + writes a row. A misbehaving doctor (or compromised account) can run the global limiter dry for the whole IP and burn R2 storage. **Impact:** Cost amplification + noisy-neighbor on rate limiter. **Fix scope:** small — add a per-doctor 10/hour limit on these two routes. **Verification:** VERIFIED-code (only `requireDoctor` middleware on the routes).

### P2-ROUTE-20 — `/api/cases/:id/intelligence/reprocess` and `/api/cases/:id/request-files` use `requireAuth()` but no role check
**Severity:** P2 | **Category:** security | **Location:** src/routes/order_flow.js:686, 723 | **Description:** Any authenticated user (patient, doctor, admin) can call reprocess or request-files on any case id. Handler likely re-checks ownership but the route definition allows the call. The neighbour `GET /api/cases/:id/intelligence` (line 652) is also `requireAuth()` only. **Impact:** Cross-case intelligence reprocess by a malicious patient on another patient's case (unless handler defends). **Fix scope:** small — restrict to `requireRole('doctor','admin','superadmin')` for reprocess + add ownership check inside the handler. **Verification:** INFERRED (route signature; handler body not fully read).

### P2-ROUTE-21 — `/api/v1/auth/forgot-password` is rate-limited only by the auth limiter (20 / 15min) — same bucket as login/refresh
**Severity:** P2 | **Category:** abuse | **Location:** src/routes/api_v1.js:47-71 + src/routes/api/auth.js:298-341 | **Description:** Same `authLimiter` covers `register`, `login`, `refresh`, `otp/request`, `otp/verify`, `forgot-password`, `reset-password`. A single attacker can spam forgot-password with random emails and starve real users of their 20/window login attempts. **Impact:** Reset-link spam + login DoS for shared-IP users (NAT, mobile carriers). **Fix scope:** small — separate `forgotPasswordLimiter` (5/hour per email + per IP). **Verification:** VERIFIED-code.

### P2-ROUTE-22 — `POST /api/help-me-choose` accepts `messages` array of length 10 × 500 chars without auth, sending each into Anthropic API
**Severity:** P2 | **Category:** cost | **Location:** src/routes/ai_assistant.js:89-120 | **Description:** Rate limit is 20/min/IP and `validate:false`. A small distributed attack (or even a single high-volume client) burns Anthropic budget at the documented model `claude-sonnet-4-20250514` × 400 max_tokens. No auth, no captcha, no per-session quota. **Impact:** Direct $$ exfiltration on the Anthropic key. **Fix scope:** small — drop max to 5/min/IP, require a session cookie (any CSRF roundtrip already proves browser+human), and tighten the role limit so unauthed visitors get 3/min. **Verification:** VERIFIED-code.

### P2-ROUTE-23 — `GET /portal/doctor/:doctorId/reviews` is intentionally public but lookups any user-id including non-doctors leak existence
**Severity:** P2 | **Category:** security | **Location:** src/routes/reviews.js:162-200 | **Description:** Returns 404 if `users.role != 'doctor'` and 200 otherwise. By probing ids an attacker can confirm whether an id belongs to a doctor (vs patient/admin). Combined with the `/admin/doctors/:id/national-id` route (admin.js:1783) that uses the same `:id` namespace, this creates an enumeration oracle. Practically: doctors are listed publicly elsewhere, so this is mostly fine — flag for completeness. **Impact:** Minor enumeration. **Fix scope:** small — return 404 unconditionally on missing/wrong role. **Verification:** VERIFIED-code.

### P2-ROUTE-24 — `csrf.js` exempts a literal `/callback` path that no longer exists (only `/payments/callback` does)
**Severity:** P2 | **Category:** routes/cleanup | **Location:** src/middleware/csrf.js:83 | **Description:** `if (p === '/callback' || p.startsWith('/portal/video/payment/callback') || p.startsWith('/payments/callback')) return next();` — the bare `/callback` clause is dead code (the only `router.post('/callback', ...)` is in payments.js, which is mounted at `/payments`, so the actual path is `/payments/callback`, already covered by the third clause). If anyone ever adds a global `app.use(paymentRoutes)` without the `/payments` prefix again, this would silently re-enable an open POST to a webhook. **Impact:** Confusing security surface; latent footgun. **Fix scope:** small — delete the `/callback` clause. **Verification:** VERIFIED-code.

### P3-ROUTE-25 — `analytics.js` CSV export does not escape embedded newlines in cell values
**Severity:** P3 | **Category:** contract | **Location:** src/routes/analytics.js:395-404 | **Description:** Wraps each value in `"…"` and doubles inner quotes, but does nothing for `\n` inside notes/service names. Most spreadsheet consumers handle quoted newlines fine, but some (Excel locale variants, certain BI tools) split rows on raw `\n`. **Impact:** Garbled CSV export rare-case. **Fix scope:** small — strip or replace `\r\n` inside quoted cells. **Verification:** VERIFIED-code.

### P3-ROUTE-26 — `attachUser` in src/auth.js accepts JWT from cookies named `token`, `auth`, `jwt`, `access_token`, `accessToken` in addition to the configured session cookie
**Severity:** P3 | **Category:** security | **Location:** src/auth.js:56-81 | **Description:** Defensive fallback for legacy cookies. There is no current code path that sets these names, but the fallback would silently accept a forged cookie if the JWT signature is valid (different scope, different deployment, etc.). **Impact:** Cross-environment session bleed if the same JWT_SECRET is reused. **Fix scope:** small — pin to `process.env.SESSION_COOKIE_NAME` only. **Verification:** VERIFIED-code.

### P3-ROUTE-27 — `setupCsrf` middleware sets `csrf_token` cookie on every non-asset GET, including 404s and bot crawls, with 7-day expiry
**Severity:** P3 | **Category:** routes/cost | **Location:** src/middleware/csrf.js:32-44 | **Description:** Every uncached GET issues a `Set-Cookie` header even for unknown paths and bot UA hits. Adds bytes per response and reduces CDN cacheability. **Impact:** Minor bandwidth/cache friction. **Fix scope:** small — only ensure the cookie when actually rendering a CSRF-needing response (or after first POST attempt). **Verification:** VERIFIED-code.

### P3-ROUTE-28 — `POST /superadmin/instagram/add-post` and similar `/superadmin/instagram/*` routes don't dedupe with `/api/admin/instagram/*` mount
**Severity:** P3 | **Category:** routes/cleanup | **Location:** src/routes/superadmin.js:2965-3093 + src/instagram/routes.js (mounted at `/api/admin/instagram`) | **Description:** Two parallel admin surfaces for Instagram management — the EJS form-driven `/superadmin/instagram/*` and the JSON `/api/admin/instagram/*`. They share `requireRole('superadmin')` but operate on the same DB rows independently. Risk of contract drift if new fields are added on one side. **Impact:** Maintenance debt; not a bug today. **Fix scope:** medium — pick one surface and redirect the other. **Verification:** VERIFIED-code.

### P3-ROUTE-29 — `/admin/orders/:id/uploads/lock?format=json` reads `req.query.format` but the form sends a query string AND a method=post — works in Express 4 but is non-idiomatic
**Severity:** P3 | **Category:** contract | **Location:** src/routes/admin.js:2018,2100 + src/views/admin_order_detail.ejs (action attrs with `?format=json`) | **Description:** Posting to a URL with a query string is supported but unusual; future moves to a stricter framework (Fastify, etc.) might not split body+query the same way. **Impact:** Latent migration risk. **Fix scope:** small — move format into the body. **Verification:** VERIFIED-code.

### P3-ROUTE-30 — `requireOpsAuth` throws on missing `JWT_SECRET` at module load time (ops.js:115) — boot order coupling
**Severity:** P3 | **Category:** routes/boot | **Location:** src/routes/ops.js:114-115 | **Description:** Top-level `if (!JWT_SECRET) throw new Error(...)` runs at `require()` time. If anything tries to `require('./routes/ops')` in a context without the env (tests, scripts), the process dies with no graceful handling. Other routes use lazy checks. **Impact:** Fragile boot in tooling/test environments. **Fix scope:** small — move into `requireOpsAuth` body and return 503 if missing. **Verification:** VERIFIED-code.

### P3-ROUTE-31 — `/api/v1/auth/otp/request` does not check whether `phone` is already a registered patient; OTPs sent to arbitrary numbers
**Severity:** P3 | **Category:** abuse/cost | **Location:** src/routes/api/auth.js:160-198 | **Description:** Generates OTP and sends Twilio SMS for any `phone+countryCode` combo. The auth limiter caps 20 in 15 min per IP, but each one fires an SMS that costs money and lands on a random number that may or may not have signed up. Combined with auto-create on `/otp/verify` (line 268) this is the intended flow, but a determined attacker can still burn Twilio budget at 20×4 = 80 SMS/hour/IP. **Impact:** SMS cost amplification. **Fix scope:** small — record `otp_codes.created_at` and reject re-requests for the same phone within 60s; cap per-phone to 5/hour. **Verification:** VERIFIED-code.

### P3-ROUTE-32 — `verify.js` and `health.js` export setup factories but their routes don't appear in the `/__version` HTML response — minor consistency
**Severity:** P3 | **Category:** observability | **Location:** src/routes/verify.js, src/routes/health.js | **Description:** `/health`, `/status`, `/healthz`, `/__version`, `/verify`, `/verify.json` are healthy but the format mixes JSON and HTML. Mobile probes that hit `/health` get JSON; ELB-style probes on `/healthz` get HTML — unconventional. Nothing actionable for launch. **Impact:** Minor friction wiring up monitors. **Fix scope:** small — standardize on JSON. **Verification:** INFERRED (route signatures only).

### P3-ROUTE-33 — `/portal/doctor/profile/photo/remove` and `/signature/remove` POST routes have no `confirm` body field; double-click deletes data
**Severity:** P3 | **Category:** UX/data integrity | **Location:** src/routes/doctor.js:2678, 2794 | **Description:** No idempotency guard or confirm token. UI level confirmation is the only safeguard. **Impact:** Accidental deletion. **Fix scope:** small — require `confirm=1` in body. **Verification:** VERIFIED-code (handler signatures only).

### P3-ROUTE-34 — `addons.js` (96 lines) and `help.js` (42 lines) routes were not deeply audited — covered by inventory only
**Severity:** P3 | **Category:** audit/coverage | **Location:** src/routes/addons.js, src/routes/help.js | **Description:** Time-budget call. Both are short and consist of GET render + minor POSTs. Recommend a 15-min follow-up read for completeness. **Impact:** Coverage gap, not a known bug. **Fix scope:** small. **Verification:** INFERRED.

### P3-ROUTE-35 — `app.use(requirePhone())` runs globally before CSRF middleware (server.js:228) and before route mounts — no risk found, but ordering is fragile
**Severity:** P3 | **Category:** boot/middleware | **Location:** src/server.js:228 + src/middleware/requirePhone.js | **Description:** `requirePhone()` is mounted before CSRF setup (line 416) — if it ever decides to redirect on a POST, the response would be unprotected. Today it's safe (self-gates on patient role + GET requests), but the ordering is the kind of thing that becomes a security regression on refactor. **Impact:** Latent regression risk. **Fix scope:** small — move requirePhone after CSRF middleware so any redirect-by-side-effect is post-token-validation. **Verification:** VERIFIED-code.

---

## Coverage Notes

- **Did NOT deep-read:** doctor.js (4325 LoC), patient.js (3073), superadmin.js (3092), admin.js (2791) — sampled handlers only. Heavy admin surfaces likely have additional CSRF-shape and ownership-shape bugs worth a pass with the same lens (P0-ROUTE-3-style anonymous mutation, P2-ROUTE-18-style cross-tenant access).
- **Form-action vs route map:** spot-checked ~25 of ~80 unique form actions; all sampled forms map to a handler except `/case/new` (P1-ROUTE-7) and `/order/upload` (P1-ROUTE-8).
- **Public webhook authentication:** confirmed Paymob HMAC for both case (`/payments/callback`) and video (`/portal/video/payment/callback`) flows; no Twilio/Instagram/Meta inbound webhooks found.
- **Mount-prefix doubles:** none found. `/payments/paymob/create-intention` and `/payments/callback` are correct (mount `/payments` + relative paths). Views at `/payments/paymob/create-intention` (patient_payment_required.ejs:447) and `/payments/callback` (csrf.js:83 exempt) match.
- **Duplicate registrations:** none active. `/order/start` is defined twice in order_flow.js but the second instance is inside a `/* */` comment.


---

# Section 02 — Views inventory + locals/CSP/CSRF audit

# Views Audit — 2026-05-06

## Inventory

- Total `.ejs` files in `src/views/`: 154
- Total `.bak` siblings (debt): 17
- Layouts: `layouts/auth.ejs`, `layouts/portal.ejs`, `layouts/public.ejs` (+ `layouts/portal.ejs.bak`)
- Partials: 30 (under `partials/`, `partials/doctor/`, `partials/patient/`)
- Views containing inline `<script>` tags (excluding `src=` and JSON-LD): 65 occurrences across ~50 files
- Views containing at least one `<form>`: 63
- Views containing inline event handlers (`onclick`/`onchange`/`onkeydown`): 9 distinct files
- `.bak` files (all in `src/views/`):
  - `doctor_alerts.ejs.bak`, `doctor_analytics.ejs.bak`, `doctor_appointments.ejs.bak`,
    `doctor_case_intelligence.ejs.bak`, `doctor_prescribe.ejs.bak`,
    `doctor_prescriptions_list.ejs.bak`, `layouts/portal.ejs.bak`,
    `patient_alerts.ejs.bak`, `patient_appointments_list.ejs.bak`,
    `patient_prescription_detail.ejs.bak`, `patient_prescriptions.ejs.bak`,
    `patient_records.ejs.bak`, `patient_referrals.ejs.bak`,
    `patient_review_form.ejs.bak`, `patient_reviews.ejs.bak`,
    `portal_doctor_guide.ejs.bak`, `portal_doctor_profile.ejs.bak`

CSP nonce flow recap (`src/server.js:231-253`): `res.locals.cspNonce` and `req.cspNonce` are populated for every request before any route runs. `style-src` permits `'unsafe-inline'`; `script-src` does NOT — every inline `<script>` MUST carry the nonce or it is blocked. CSRF middleware (`src/middleware/csrf.js`) hard-rejects POST/PUT/DELETE without `_csrf` body field or `x-csrf-token` header in `enforce` mode (production / staging).

`src/middleware-nonce-fix.js` is a standalone helper (`generateNonce` + `addNonceMiddleware` writing `res.locals.nonce`). It is NOT imported anywhere in `src/server.js` or `src/middleware.js`. Dead module — kept here only because the partials defensively look at `locals.nonce` as a third fallback after `cspNonce`/`csp_nonce`.

---

## Findings

### P0-VIEW-1 — `partials/service_assistant.ejs` inline `<script>` has no CSP nonce
**Severity:** P0
**Category:** csp
**Location:** src/views/partials/service_assistant.ejs:225 (and onclick attrs at :9, :27, :49, :56, :58)
**Description:** The partial opens a bare `<script>` tag. There is no nonce attribute on the script and the trigger DOM emits inline `onclick="saOpen()"`, `onclick="saClose()"`, `onclick="saReset()"`, `onclick="saSend()"`, and `onkeydown="..."` event handlers. Neither inline-event-handler attributes nor unsigned inline scripts are permitted by the page CSP (`script-src 'self' 'nonce-…'`), so the assistant entry point and all its handlers are silently rejected.
**Impact:** This partial is included from `services.ejs` and from the dead `order_start.ejs`. The `/services` page renders the bubble + modal, but every click is a no-op. Browser console shows multiple "Refused to execute inline event handler" errors per page. The Help-Me-Choose CTA marketed as the headline conversion tool from `/services` is dead.
**Fix scope:** medium
**Verification:** VERIFIED-code

### P0-VIEW-2 — `help_me_choose.ejs` inline `<script>` has no nonce, plus inline `onclick` / `onkeydown`
**Severity:** P0
**Category:** csp
**Location:** src/views/help_me_choose.ejs:47, 55, 56, 106
**Description:** Same pattern as service_assistant — bare `<script>` block at line 106 plus `onclick="saReset()"` / `onkeydown="…saSend()"` / `onclick="saSend()"` attributes inline. None pass through any nonce. The view is rendered by `static-pages.js:72` which does not pass `cspNonce` (and the script tag would not read it anyway).
**Impact:** `/help-me-choose` loads but `saSend()` / `saReset()` are unbound; the AI service-recommender chat is broken.
**Fix scope:** medium
**Verification:** VERIFIED-code

### P0-VIEW-3 — `doctor_signup.ejs` inline `<script>` has no nonce
**Severity:** P0
**Category:** csp
**Location:** src/views/doctor_signup.ejs:363
**Description:** The `<script>` block driving step transitions, the `data-action="next-step"` / `prev-step` wiring, the repeater widget, the service-group toggle, and form validation is emitted with no nonce attribute. Route at `routes/auth.js:753` does pass `cspNonce` indirectly via res.locals but the template never reads it for this script.
**Impact:** Doctor signup wizard cannot advance past Step 1 — clicking "Next" calls a handler that the browser refuses to execute. Repeater rows for credentials / education don't add. Specialty-conditional services panel never reveals. `/doctor/signup` is functionally dead.
**Fix scope:** small
**Verification:** VERIFIED-code

### P0-VIEW-4 — `video_appointment.ejs` Paymob button inline `<script>` has no nonce
**Severity:** P0
**Category:** csp
**Location:** src/views/video_appointment.ejs:197
**Description:** Inside the `paymob-container` block (lines 194–209), an inline `<script>` builds the Pay-Now button DOM-side and wires the click handler. No nonce attribute. Other scripts in the same view (line 345) correctly emit `nonce="…"`.
**Impact:** The "Pay Now — N EGP" button never appears for video consultations because `container.appendChild(btn)` is in the blocked script. Patients can't pay for video appointments through this view.
**Fix scope:** small
**Verification:** VERIFIED-code

### P0-VIEW-5 — `patient_walkthrough.ejs` inline `<script>` has no nonce
**Severity:** P0
**Category:** csp
**Location:** src/views/patient_walkthrough.ejs:783
**Description:** The wizard step-controller `<script>` (Prev / Next button wiring, dot-progression, Arabic numeral switching, ~80 lines) is emitted without a nonce attribute. The route at `routes/help.js:25` does pass `cspNonce` to the locals — the template just never threads it onto the tag.
**Impact:** `/patient-walkthrough` shows step 1 then becomes inert — the Next button does nothing. Used in onboarding flows; first-time patients hit a dead end.
**Fix scope:** small
**Verification:** VERIFIED-code

### P0-VIEW-6 — `ops-dashboard.ejs` inline `<script>` has no nonce
**Severity:** P0
**Category:** csp
**Location:** src/views/ops-dashboard.ejs:391
**Description:** The 60-second auto-refresh countdown `<script>` is bare. CSP applies to `/ops/dashboard` (no exemption in `src/server.js`), so the countdown never ticks and the page never auto-reloads.
**Impact:** Ops dashboard doesn't auto-refresh; operator must manually reload to see the latest agent status / SLA telemetry.
**Fix scope:** small
**Verification:** VERIFIED-code

### P0-VIEW-7 — `index.ejs` (homepage) inline `onclick="switchLang(...)"` is CSP-blocked
**Severity:** P0
**Category:** csp
**Location:** src/views/index.ejs:82, 83
**Description:** The header EN / AR pills use `onclick="switchLang('en'); return false;"` / `onclick="switchLang('ar'); return false;"`. CSP `script-src` blocks all inline event handlers. The script that defines `switchLang` is loaded via `/site/js/i18n-site.js` (allowed), but the inline handler that calls it is not.
**Impact:** Homepage language toggle silently does nothing on click. Default language stays as English; Arabic visitors cannot switch. `href="#"` then prevents navigation either way.
**Fix scope:** small
**Verification:** VERIFIED-code

### P0-VIEW-8 — `messages.ejs` `onclick="reopenConversation()"` inline + undefined fn
**Severity:** P0
**Category:** csp / render
**Location:** src/views/messages.ejs:128
**Description:** The "Reopen" button on closed conversations uses `onclick="reopenConversation()"`. The handler is CSP-blocked and `reopenConversation` is not defined anywhere in the codebase (`grep -rn 'reopenConversation' src/` returns only this single occurrence).
**Impact:** Patients on a closed conversation cannot reopen it. Button looks live but does nothing.
**Fix scope:** medium (need both nonce-safe binding AND a server endpoint)
**Verification:** VERIFIED-code

### P0-VIEW-9 — `ops-errors.ejs` table rows use inline `onclick="location.href=…"`
**Severity:** P0
**Category:** csp
**Location:** src/views/ops-errors.ejs:77
**Description:** Each error row is `<tr class="clickable" onclick="location.href='/ops/errors/<id>'">`. CSP blocks the inline handler. Rows are clickable in the visual sense (CSS `.clickable`) but tapping them does nothing.
**Impact:** Ops error log list is read-only and you must copy/paste IDs to navigate to detail pages.
**Fix scope:** small
**Verification:** VERIFIED-code

### P0-VIEW-10 — `ops-error-detail.ejs` three `onclick` attributes
**Severity:** P0
**Category:** csp
**Location:** src/views/ops-error-detail.ejs:53, 70, 74
**Description:** "copy" buttons (`onclick="navigator.clipboard.writeText(...)"`) and the stack-trace expand toggle (`onclick="var b=...; b.classList.toggle('expanded'); ..."`) are inline event handlers. All blocked.
**Impact:** Ops engineers cannot copy error IDs / stack traces with one click and cannot expand the truncated stack to see the full trace.
**Fix scope:** small
**Verification:** VERIFIED-code

### P0-VIEW-11 — `partials/patient/error-state.ejs` `onclick="window.location.reload()"`
**Severity:** P0
**Category:** csp
**Location:** src/views/partials/patient/error-state.ejs:31
**Description:** The "Retry" primary button on the patient error-state partial uses inline `onclick`. Wherever this partial is included (network failure overlays, etc.), the retry button is dead.
**Impact:** Patient sees an error overlay with a useless Retry CTA. Lowers recovery rate.
**Fix scope:** small
**Verification:** VERIFIED-code

### P0-VIEW-12 — `error.ejs` "Go Back" uses `href="javascript:history.back()"`
**Severity:** P0
**Category:** csp
**Location:** src/views/error.ejs:32
**Description:** `javascript:` pseudo-URL is blocked by CSP `script-src` regardless of nonce. This view is rendered by `src/server.js:814` AND by 5 sites in `routes/video.js` AND by 3 sites in `routes/reports.js` (the global error-render path), so any error page on those flows shows a dead Back button.
**Impact:** On any 4xx/5xx hit through `error.ejs`, "Go Back" is non-functional. User has to use browser back button or click Home.
**Fix scope:** small (replace with `<button data-action="history-back">` + delegated handler, or just drop)
**Verification:** VERIFIED-code

### P0-VIEW-13 — `patient_prescription_detail.ejs` "Print" uses `href="javascript:window.print()"`
**Severity:** P0
**Category:** csp
**Location:** src/views/patient_prescription_detail.ejs:58
**Description:** Same `javascript:` URL CSP violation. Patients trying to print a prescription get nothing.
**Impact:** Print button is a primary affordance for prescription receipts — silently broken on every browser since CSP enforcement landed.
**Fix scope:** small
**Verification:** VERIFIED-code

### P0-VIEW-14 — `partials/patient/notifications-dropdown.ejs` POST form has no CSRF token
**Severity:** P0
**Category:** csrf
**Location:** src/views/partials/patient/notifications-dropdown.ejs:15-17
**Description:** The "Mark all read" form posts to `<%= __markUrl %>` (default `/portal/patient/alerts/mark-all-read`) but the body contains no CSRF input and the partial does not call `csrfField()`. CSRF middleware in `enforce` mode rejects the POST with HTTP 403.
**Impact:** Mark-all-read action fails on the JS-disabled fallback rendering of the dropdown. (The JS path in `partials/patient/foot.ejs` also POSTs without a CSRF token — see VIEW-15 below — so the function is broken on both paths.)
**Fix scope:** small (add `<%- csrfField() %>` inside the `<form>`)
**Verification:** VERIFIED-code

### P0-VIEW-15 — `partials/patient/foot.ejs` mark-all-read fetch has no CSRF header
**Severity:** P0
**Category:** csrf
**Location:** src/views/partials/patient/foot.ejs:253-256
**Description:** Inside the bell-dropdown JS, the fetch on close does `fetch(markAllUrl, { method: 'POST', credentials: 'same-origin', headers: { 'X-Requested-With': 'fetch' } })`. No `x-csrf-token`. `src/middleware/csrf.js:50-56` only reads `x-csrf-token` header or `_csrf` body field.
**Impact:** Closing the bell dropdown silently 403s server-side; the unread count appears to clear locally (`setDot(0)`) but the server-side state never updates, so on next page load all "new" notifications return.
**Fix scope:** small
**Verification:** VERIFIED-code

### P1-VIEW-16 — `portal_doctor_dashboard.ejs` welcome-dismiss fetch has no CSRF header
**Severity:** P1
**Category:** csrf
**Location:** src/views/portal_doctor_dashboard.ejs:701-705
**Description:** The welcome-modal dismiss POST to `/portal/doctor/onboarding/dismiss` sends only `Content-Type: application/json`, no `x-csrf-token`. The endpoint at `routes/doctor.js:1420` is a normal POST gated by `requireDoctor` and the global CSRF middleware.
**Impact:** Server-side dismiss never persists on first dismiss, so the welcome modal re-shows on next load. Mitigated by a `try { localStorage } catch` that hides it client-side, but the server-side `users.welcome_dismissed` (or equivalent) flag stays false. Docs comment claims a "fire-and-forgets UPDATE on first page-load" handles this, but that pre-fire is not visible in the code.
**Fix scope:** small
**Verification:** VERIFIED-code

### P0-VIEW-17 — `video_appointment.ejs` calls `dayjs(...)` server-side but route never injects dayjs
**Severity:** P0
**Category:** render
**Location:** src/views/video_appointment.ejs:50, 71, 94, 155, 254, 264, 289, 304, 309, 395
**Description:** The template calls `dayjs(...)` ten times in EJS scriptlets (`<%= dayjs(a.scheduled_at).format(...) %>`). `dayjs` is required at the top of `routes/video.js` but never passed as a local in any of the four `res.render('video_appointment', ...)` call-sites (lines 123, 260, 406, 1275). EJS is configured at default (no `with`-disable) so unknown identifiers throw `ReferenceError: dayjs is not defined`.
**Impact:** Every render of `video_appointment` (book / pay / view / reschedule) crashes with a 500 the moment any conditional reaches a `dayjs(...)` line. Entire video-consultation flow is dead. Also: `dayjs(...)` is used as `min` for a datetime input on line 395, so even the doctor-side propose-slot form crashes.
**Fix scope:** small (pass `dayjs` as a local in all four render call-sites, or replace with native `Date.toLocaleString`).
**Verification:** VERIFIED-code

### P1-VIEW-18 — `appointment_booking.ejs` form has no CSRF and route never renders it
**Severity:** P1
**Category:** csrf / debt
**Location:** src/views/appointment_booking.ejs:34-60
**Description:** The view defines `<form id="bookingForm">` with no `method`, no `action`, no `csrfField()`. It also references `doctor.name`, `doctor.id`, `order.id`, `slots`, `timezones`, `appointmentPrice` without typeof guards. No `res.render('appointment_booking', ...)` exists anywhere in `src/routes` or `src/server.js`. View is dead but reachable if any URL maps to it via the doctor.js fallback view-name resolver.
**Impact:** Dead code that would crash on render if ever reached. Confuses code search results and contradicts the appointment_availability view (which is the live one).
**Fix scope:** small (delete the file)
**Verification:** VERIFIED-code

### P1-VIEW-19 — `appointment_detail.ejs` is dead code
**Severity:** P1
**Category:** debt
**Location:** src/views/appointment_detail.ejs:all
**Description:** No `res.render('appointment_detail', ...)` exists in the codebase. Includes inline `<script>` (with nonce-guarded attribute, harmless) but the file is unreachable.
**Impact:** Dead code. Adds maintenance load and false hits in greps.
**Fix scope:** small (delete)
**Verification:** VERIFIED-code

### P1-VIEW-20 — `public_case_new.ejs` is dead code
**Severity:** P1
**Category:** debt
**Location:** src/views/public_case_new.ejs:all
**Description:** No `res.render('public_case_new', ...)` exists. View dereferences `error`, `form`, `specialties` without typeof guards. Pairs with `public_case_thankyou.ejs` which is also unrendered.
**Impact:** Dead code. Drift risk: on-call engineer might "fix" this file and never see results.
**Fix scope:** small (delete or restore route)
**Verification:** VERIFIED-code

### P1-VIEW-21 — `order_start.ejs` is dead — handler redirects to `coming_soon`
**Severity:** P1
**Category:** debt
**Location:** src/views/order_start.ejs:all
**Description:** `routes/order_flow.js:115-119` short-circuits `/order/start` to render `coming_soon`. The original render is commented out. View remains and includes `partials/service_assistant` (which is itself broken, see VIEW-1).
**Impact:** Dead code, plus it is the only other consumer of `service_assistant.ejs` besides `services.ejs`. If launch flips back to live, both will render the broken assistant.
**Fix scope:** small
**Verification:** VERIFIED-code

### P1-VIEW-22 — `order_payment.ejs` is dead code; references undeclared locals
**Severity:** P1
**Category:** debt / render
**Location:** src/views/order_payment.ejs:13-69
**Description:** No render call exists. Body references `sessionToken`, `reason`, `urgency`, `language`, `files` directly without typeof guards. If route ever wired up, all five would throw `ReferenceError` on cold render.
**Impact:** Dead code with hidden landmines.
**Fix scope:** small
**Verification:** VERIFIED-code

### P0-VIEW-23 — `admin_pricing.ejs` line 148 uses `<%= cspNonce %>` without typeof guard
**Severity:** P0
**Category:** csp / render
**Location:** src/views/admin_pricing.ejs:148
**Description:** `<script nonce="<%= cspNonce %>">` — if for any reason the locals scope drops `cspNonce` (e.g., a defensive render or a future EJS upgrade with `with` disabled), this throws `ReferenceError: cspNonce is not defined` at render. Mitigated today only because the global CSP middleware always sets `res.locals.cspNonce` and EJS's default `with` keeps it in scope.
**Impact:** Latent bug. Same pattern repeats in `admin_campaign_new.ejs:81`, `admin_campaign_detail.ejs:131`, and `services.ejs:493` (this last one uses typeof guard, OK).
**Fix scope:** small (use `<% if (typeof cspNonce !== 'undefined' && cspNonce) { %> nonce="<%= cspNonce %>"<% } %>` — the existing convention).
**Verification:** VERIFIED-code

### P0-VIEW-24 — `admin_campaign_new.ejs` same unguarded `<%= cspNonce %>`
**Severity:** P0
**Category:** csp / render
**Location:** src/views/admin_campaign_new.ejs:81
**Description:** Same issue as VIEW-23.
**Impact:** Latent ReferenceError.
**Fix scope:** small
**Verification:** VERIFIED-code

### P0-VIEW-25 — `admin_campaign_detail.ejs` same unguarded `<%= cspNonce %>`
**Severity:** P0
**Category:** csp / render
**Location:** src/views/admin_campaign_detail.ejs:131
**Description:** Same issue as VIEW-23.
**Impact:** Latent ReferenceError.
**Fix scope:** small
**Verification:** VERIFIED-code

### P1-VIEW-26 — `appointment_availability.ejs` calls bare `csrfField()` and never closes layout
**Severity:** P1
**Category:** csrf / render
**Location:** src/views/appointment_availability.ejs:12, 41
**Description:** Line 12 uses `<%- csrfField() %>` directly (no `typeof csrfField === 'function'` guard). The form on line 11 has `method="POST"` but no `action` attribute (defaults to current URL). The view ends at line 41 without a closing `partials/footer` include — so the `portal-shell` opened by header is never closed, leaving the page DOM unbalanced.
**Impact:** Form would post back to GET `/portal/doctor/availability` (mismatch). DOM unbalance leaks `</main></div>` tags. csrfField is set globally, so the call works at runtime, but the bare invocation is fragile.
**Fix scope:** small
**Verification:** VERIFIED-code

### P1-VIEW-27 — `intake_form.ejs` `<%= error %>` — local accessed without typeof guard
**Severity:** P1
**Category:** render
**Location:** src/views/intake_form.ejs:35
**Description:** `<% if (error) { %>` — references `error` directly. The two `res.render('intake_form', ...)` sites at `routes/intake.js:150` and `:264` both pass `error: null` so OK at runtime, but a future caller could omit it and trigger a 500.
**Impact:** Latent ReferenceError if any future render path forgets to pass `error`.
**Fix scope:** small (change to `typeof error !== 'undefined' && error`)
**Verification:** VERIFIED-code

### P1-VIEW-28 — `register.ejs` `<%= error %>` unguarded
**Severity:** P1
**Category:** render
**Location:** src/views/register.ejs:11
**Description:** Same as VIEW-27. Render at `auth.js:573` passes `error: null`; OK at runtime.
**Impact:** Latent.
**Fix scope:** small
**Verification:** VERIFIED-code

### P1-VIEW-29 — `superadmin_order_new.ejs` `<%= error %>` unguarded
**Severity:** P1
**Category:** render
**Location:** src/views/superadmin_order_new.ejs:24
**Description:** Same pattern. Render at `superadmin.js:1569` passes error.
**Impact:** Latent.
**Fix scope:** small
**Verification:** VERIFIED-code

### P2-VIEW-30 — `partials/header.ejs` doesn't pass `cspNonce` to layouts
**Severity:** P2
**Category:** csp / debt
**Location:** src/views/partials/header.ejs:5, 7, 9
**Description:** `header.ejs` selects a layout and does `<%- include('../layouts/portal') %>` (no explicit locals). Layouts each defensively read `cspNonce` from `locals`, which works under EJS 3.x with default `with: true`. If a future EJS bump or `with: false` flag is set, the nonce would silently drop in all three layouts → all inline tour scripts and event delegators stop running.
**Impact:** Latent CSP regression. Hardening: explicit `{ cspNonce: cspNonce, isAr: isAr, lang: lang, ... }` pass-through.
**Fix scope:** medium
**Verification:** VERIFIED-code

### P2-VIEW-31 — Patient-portal `foot.ejs` includes mostly omit `cspNonce`
**Severity:** P2
**Category:** csp
**Location:** Across 18 views (e.g., `patient_dashboard.ejs:430`, `patient_profile.ejs:202`, `patient_prescriptions.ejs:101`, `patient_review_form.ejs:175`, `patient_alerts.ejs:163`, `patient_records.ejs:268`, `patient_referrals.ejs:143`, `patient_appointments_list.ejs:135`, `patient_reviews.ejs:120`, `patient_payment_required.ejs:487`, `patient_case_report.ejs:357`, `patient_500.ejs:51`, `patient_404.ejs:36`, `patient_payment_success.ejs:184`, `patient_order_upload.ejs:320`, `patient_order.ejs:854`, `patient_prescription_detail.ejs:111`, `patient_dashboard.ejs:430`)
**Description:** Only `patient_new_case.ejs:987` explicitly threads `cspNonce: cspNonce` into the foot include. The other 17 includes rely on EJS-3's default `with` to leak the locals scope into the partial. `partials/patient/foot.ejs:17-22` reads it defensively from `typeof cspNonce` and `locals.cspNonce`. This works today but is exactly the bug pattern that commit `e0f0183` was filed for on `patient_new_case.ejs`. The fix landed on one file; the rest of the portal is still vulnerable.
**Impact:** If EJS config changes (or any partial-include pattern shifts) the more-sheet drawer JS and the bell JS will be CSP-blocked across the entire patient portal in one shot.
**Fix scope:** medium (explicitly pass `cspNonce` in all 17 sites, mirror commit `e0f0183`)
**Verification:** VERIFIED-code

### P2-VIEW-32 — `patient_404.ejs` and `patient_500.ejs` foot include omits `cspNonce`
**Severity:** P2
**Category:** csp
**Location:** src/views/patient_404.ejs:36-41, src/views/patient_500.ejs:51-56
**Description:** Subset of VIEW-31. Both error pages also pass `hideBell: !user`, which suppresses one of the two scripts inside foot.ejs. The remaining script (more-sheet wiring) still needs the nonce. If the locals leak fails, the mobile More tab is dead on every error page.
**Impact:** Worst-case: unauthenticated patient hits 404 → mobile nav unusable (no way to navigate from More).
**Fix scope:** small
**Verification:** VERIFIED-code

### P1-VIEW-33 — `target="_blank"` without `rel="noopener noreferrer"` (21 sites)
**Severity:** P1
**Category:** xss / a11y
**Location:** Multiple — register.ejs:53, 55; ops-error-detail.ejs:55; patient_records.ejs:140; ops-dashboard.ejs:382-387 (5 occurrences); patient_referrals.ejs:55; order_upload.ejs:145 (×2); doctor_signup.ejs:342 (×2); plus ~10 more.
**Description:** `window.opener` access is the historical reverse-tabnabbing vector. Modern browsers (Chrome 88+, Firefox 79+, Safari 12.1+) implicitly add `noopener` for `target="_blank"`, so this is largely a hardening item now. Older browsers in MENA (Samsung Internet pre-19, UC Browser variants) still don't.
**Impact:** Tabnabbing: a malicious externally-linked site could call `window.opener.location = …` and redirect the original tab to a phishing replica of `tashkheesa.com`. Probability: low; severity: high.
**Fix scope:** small (add `rel="noopener noreferrer"` to all 21 sites)
**Verification:** VERIFIED-code

### P1-VIEW-34 — `_app_waitlist_form.ejs` form has no method/action
**Severity:** P1
**Category:** csrf / render
**Location:** src/views/_app_waitlist_form.ejs:6
**Description:** `<form class="app-waitlist-form" autocomplete="on">` — no `method`, no `action`, no CSRF input. The script in `app_landing.ejs:148` intercepts submit via `e.preventDefault()` then fetches manually, but if JS is disabled or the script-load fails (CSP block, network error), the form falls back to a GET to the current URL with empty handler.
**Impact:** No-JS users submitting the waitlist get a noop GET to the homepage; their email is lost. Conversion-funnel bug.
**Fix scope:** small (add `method="post" action="/api/app-waitlist"` + a server fallback handler)
**Verification:** VERIFIED-code

### P2-VIEW-35 — `coming_soon.ejs` interest form has no `method`/`action`
**Severity:** P2
**Category:** csrf
**Location:** src/views/coming_soon.ejs:289
**Description:** `<form class="interest-form" id="interestForm">` — JS-only submission via fetch. Includes `csrfToken` in the fetch headers (line 372–375), so the active path works. But no `method`/`action`/CSRF input fallback for no-JS users.
**Impact:** No-JS user clicks Submit → form GETs the current URL with form-encoded params in the query string. Email never reaches the database. Pre-launch interest signal corrupted.
**Fix scope:** small
**Verification:** VERIFIED-code

### P1-VIEW-36 — `services.ejs` includes broken `service_assistant.ejs`
**Severity:** P1
**Category:** csp
**Location:** src/views/services.ejs:497
**Description:** Includes the partial whose inline `<script>` and `onclick` handlers are CSP-blocked (see VIEW-1). The `services.ejs` page itself is otherwise compliant (line 493 `<script nonce="…">` works) but the bubble in the corner is dead.
**Impact:** Marketing CTA "Help me choose" on `/services` is non-functional.
**Fix scope:** medium (depends on VIEW-1 fix)
**Verification:** VERIFIED-code

### P1-VIEW-37 — `messages.ejs` patient role uses non-v2 sidebar partial
**Severity:** P1
**Category:** debt / render
**Location:** src/views/messages.ejs:59
**Description:** Renders `partials/patient_sidebar` (legacy chrome) for patients while every other patient view uses `partials/patient/sidebar` (v2 chrome). Two distinct sidebar partials exist (`partials/patient_sidebar.ejs` and `partials/patient/sidebar.ejs`).
**Impact:** Visual inconsistency — patients see the v2 portal everywhere else, then a flash of legacy chrome on `/portal/messages`. Messaging is also one of the most-used sections.
**Fix scope:** medium (port to v2 head/foot pattern)
**Verification:** VERIFIED-code

### P3-VIEW-38 — Inline `style=` attributes throughout patient views
**Severity:** P3
**Category:** csp / debt
**Location:** Almost every patient view — patient_dashboard.ejs, patient_new_case.ejs, patient_order.ejs, patient_alerts.ejs, etc.
**Description:** CSP `style-src` allows `'unsafe-inline'` so these are not currently blocked. Tightening to a hash- or nonce-based style policy is blocked by hundreds of inline `style=` attributes (rough count via grep: >500 occurrences). The patient v2 design system (`patient-portal-v2.css`) was supposed to remove these.
**Impact:** Cannot tighten CSP `style-src`. No immediate functional impact.
**Fix scope:** large
**Verification:** INFERRED

### P3-VIEW-39 — 17 `.bak` files in `src/views/`
**Severity:** P3
**Category:** debt
**Location:** src/views/*.bak (see inventory)
**Description:** Stale snapshots from the doctor-portal-v2 / patient-portal-v2 migration. Each is paired with the live v2 file. `layouts/portal.ejs.bak` exists too. Express has been observed to attempt resolving some legacy lookup chains (e.g., `routes/doctor.js:1372` `candidates = ['portal_doctor_alerts', 'portal_doctor_alert', 'doctor_alerts', 'doctor_alert']`) — if any resolver bug returns a `.bak`-suffixed name we'd render stale code.
**Impact:** Drift risk; bloats the views directory; confuses on-call engineers comparing diffs.
**Fix scope:** small (delete; they're in git history)
**Verification:** VERIFIED-code

### P2-VIEW-40 — `error.ejs` writes own `<style>` block (12 lines) instead of using portal CSS
**Severity:** P2
**Category:** debt
**Location:** src/views/error.ejs:11-22
**Description:** The shared error view inlines its own stylesheet. Means error pages look distinct from every other portal page. Tightening `style-src` would also need to nonce or hash this block.
**Impact:** Visual inconsistency on error pages; tightening blocker.
**Fix scope:** small
**Verification:** VERIFIED-code

### P3-VIEW-41 — `partials/header.ejs` is a pure dispatcher with one role: include layout
**Severity:** P3
**Category:** debt
**Location:** src/views/partials/header.ejs:1-11
**Description:** The partial does nothing except branch on `layout` and call `include('../layouts/X')`. Every view ends up calling `include('partials/header', { layout: ..., ... })` which then calls `include('../layouts/portal', ...)`. Two-step indirection costs render time and obscures the locals-pass-through (which is the source of VIEW-30).
**Impact:** Code smell; not a bug.
**Fix scope:** medium (have views call layouts directly, drop header.ejs)
**Verification:** VERIFIED-code

### P3-VIEW-42 — `partials/footer.ejs` reads `cspNonce` without `typeof` guard at top
**Severity:** P3
**Category:** csp / render
**Location:** src/views/partials/footer.ejs:8-10
**Description:** Reads `locals.cspNonce` but the conditional output blocks below (lines 60, 111, 186) only render the nonce attr when `cspNonce` is truthy — guarded. So no crash, but the symmetry breaks: lines 8-10 use `String(locals.cspNonce || locals.csp_nonce || locals.nonce)` without `typeof locals !== 'undefined'`. Under EJS 3.x default it's fine; under hardened EJS it would throw.
**Impact:** Latent.
**Fix scope:** small
**Verification:** VERIFIED-code

### P2-VIEW-43 — `layouts/auth.ejs` and `layouts/public.ejs` reference `_nonce` then redeclare in `partials/footer.ejs`
**Severity:** P2
**Category:** debt
**Location:** src/views/layouts/auth.ejs:28; src/views/layouts/public.ejs:71; src/views/partials/footer.ejs:8
**Description:** Each computes a `_nonce` local. EJS scope flows through includes, so a later partial that recomputes `_nonce` is just shadowing — but if a future refactor changes the variable name in one site, the others silently lose the value.
**Impact:** Code smell only.
**Fix scope:** small
**Verification:** VERIFIED-code

### P2-VIEW-44 — `messages.ejs` polls `/api/messages/<id>/poll` with x-csrf-token but the route is in `/api/v1`-exempt prefix
**Severity:** P2
**Category:** csrf
**Location:** src/views/messages.ejs:255
**Description:** `csrf.js:80` exempts everything under `/api/v1`. The poll URL is `/api/messages/...` (not `v1`-prefixed) so it does go through CSRF. Header is set OK. But the same view also POSTs to `/portal/messages/<id>/send` (line 203) which is portal-prefixed and CSRF-protected — also OK. Only flagging because the implicit assumption "CSRF is exempt for `/api/...`" is wrong; only `/api/v1/...` is.
**Impact:** None today. Defensive note for future fetches.
**Fix scope:** none (informational)
**Verification:** VERIFIED-code

### P2-VIEW-45 — `messages.ejs` builds report modal HTML with string concatenation including raw `escapeHtml(messageId)`
**Severity:** P2
**Category:** xss
**Location:** src/views/messages.ejs:285-308
**Description:** `openReportModal(messageId)` constructs the modal via `overlay.innerHTML = ...` with `escapeHtml(messageId)` inside `value="..."`. `escapeHtml` (line 246) uses textContent → innerHTML round-trip which is correct. But the conversation_id and csrfToken are also injected via the same path. csrfToken is a 64-char hex, safe. messageId is a UUID. No active XSS, but innerHTML construction with user-influenced data is fragile.
**Impact:** Defense-in-depth concern.
**Fix scope:** medium (rebuild via document.createElement)
**Verification:** VERIFIED-code

### P2-VIEW-46 — `index.ejs` renders price range from raw locals interpolated into JSON-LD
**Severity:** P2
**Category:** xss
**Location:** src/views/index.ejs:41
**Description:** `"priceRange": "<%= currency %> <%= priceRangeMin %> - <%= currency %> <%= priceRangeMax %>"` — values escaped via `<%= %>`. JSON-LD is in a `<script type="application/ld+json">` which is data, not executable JS, so HTML-escape is the right escape mode. OK. Just noting that the JSON literal could break if currency contains a `"`.
**Impact:** None at present (currency is one of `EGP`, `USD`, etc.).
**Fix scope:** small (use `JSON.stringify` and `<%- %>` for safety)
**Verification:** VERIFIED-code

### P3-VIEW-47 — `intake_form.ejs` and `sandbox_order_intake.ejs` inline a hand-rolled patient-sidebar instead of the partial
**Severity:** P3
**Category:** debt
**Location:** src/views/intake_form.ejs:14-22, src/views/sandbox_order_intake.ejs:12-20
**Description:** Both views duplicate the patient sidebar nav inline rather than including `partials/patient_sidebar` or v2 `partials/patient/sidebar`. Drift risk: nav added in the partial doesn't appear here.
**Impact:** Stale nav links — `/portal/patient/alerts` still shows but `appointments`, `prescriptions`, `records`, `referrals`, `reviews` are missing. Patients on these flows can't reach those pages from the sidebar.
**Fix scope:** small
**Verification:** VERIFIED-code

### P3-VIEW-48 — `coming_soon.ejs` 354-line inline view with embedded `<style>` (~70 lines)
**Severity:** P3
**Category:** debt
**Location:** src/views/coming_soon.ejs
**Description:** Self-contained marketing page with all CSS inline. Doesn't use shared portal CSS. Diverges visually from the rest of the public site.
**Impact:** Visual drift; tightening `style-src` blocker.
**Fix scope:** medium
**Verification:** VERIFIED-code

### P3-VIEW-49 — `patient_payment_success.ejs` `head/foot` includes pass `cspNonce`, but the body alerts use `<%= cspNonce %>` directly
**Severity:** P3
**Category:** csp
**Location:** src/views/patient_payment_success.ejs:146
**Description:** Uses `<%= (typeof cspNonce !== 'undefined' && cspNonce) ? ' nonce="' + cspNonce + '"' : '' %>`. Correct typeof guard. Just noting consistency: across the codebase the same logical thing is written in 4 different ways (`<%- __nonceAttr %>`, `<%= cspNonce %>`, `<% if (...) { %>`, `nonce="<%= cspNonce %>"`). A single shared `nonceAttr()` helper would prevent drift.
**Impact:** Code smell.
**Fix scope:** medium
**Verification:** VERIFIED-code

### P2-VIEW-50 — `patient_order.ejs` uses `<%= ... %>` to inline `cspNonce` 4 times instead of typeof-defending
**Severity:** P2
**Category:** csp
**Location:** src/views/patient_order.ejs:556, 561, 562, 750
**Description:** `<script<%= (typeof cspNonce !== 'undefined' && cspNonce) ? ' nonce="' + cspNonce + '"' : '' %>>` — uses escaped output `<%= %>` to emit the attribute. Base64 nonces don't contain HTML metacharacters so this works. But the convention in commit `797e00e` was to use `<%- %>` for nonce attributes specifically because of past escape regressions. This is the legacy form.
**Impact:** Defensive consistency only — the page works.
**Fix scope:** small (move to `<%- __nonceAttr %>` pattern)
**Verification:** VERIFIED-code

### P1-VIEW-51 — `partials/patient/foot.ejs` More-sheet script can run before the sheet DOM exists when `hideBell: true`
**Severity:** P1
**Category:** render
**Location:** src/views/partials/patient/foot.ejs:36-96
**Description:** The first inline script always runs (regardless of `hideBell`). It does `document.querySelector('.p-tabbar__more')`. The `.p-tabbar__more` element is rendered by `mobile-tabbar.ejs` which is included on line 26 of foot.ejs (above the script). OK in normal flow. But the `mobile-more-sheet.ejs` (included by tabbar) is the one that renders `#p-more-sheet`. If `tabbar` and `more-sheet` both render successfully, the script binds. If a partial failure occurs (e.g., icon partial throws on a bad name), the More button may exist while the sheet does not — script's `if (!sheet || !backdrop || !moreBtn) return;` handles that, returning silently. OK.
**Impact:** Correct null-handling. Note for review only.
**Fix scope:** none
**Verification:** VERIFIED-code

### P2-VIEW-52 — `services.ejs` line 493 emits `<script nonce="<%= ... %>">` even when empty
**Severity:** P2
**Category:** csp
**Location:** src/views/services.ejs:493
**Description:** `<script nonce="<%= typeof cspNonce !== 'undefined' ? cspNonce : '' %>">` — when cspNonce is missing, this emits `nonce=""` which is invalid; CSP rejects. (Mitigated: cspNonce is set globally.)
**Impact:** Latent.
**Fix scope:** small
**Verification:** VERIFIED-code

### P1-VIEW-53 — `admin_doctors.ejs` views `stats`, `recentActivity`, `pendingFileRequests` via fallback but route DOES pass them
**Severity:** P1
**Category:** render
**Location:** src/views/admin_doctors.ejs:18-35
**Description:** View has typeof-guarded reads, but the `/admin/doctors` and `/superadmin/doctors` route at `routes/superadmin.js:1935` renders with only `{ user, doctors, specialties, statusFilter, pendingDoctorsCount, pausedDoctorsCount }` — no `stats`, no `recentActivity`, no `pendingFileRequests`. The `/admin/doctors` route at `routes/admin.js:1680` does pass all of them. Asymmetric: superadmin sees a doctors page with empty KPI cards, admin sees full data.
**Impact:** Superadmin doctors page is missing the KPI strip + recent-activity feed (renders as zeros / empty). Admin sees them populated.
**Fix scope:** small
**Verification:** VERIFIED-code

### P2-VIEW-54 — `partials/footer.ejs` reads `cspNonce` from `locals.cspNonce || locals.csp_nonce || locals.nonce`
**Severity:** P2
**Category:** csp
**Location:** src/views/partials/footer.ejs:8-10
**Description:** Same triple-fallback pattern as patient/foot.ejs. The third fallback `locals.nonce` would only be set by the dead `middleware-nonce-fix.js`. Defensive but contains a stale path.
**Impact:** Confuses readers who grep for `nonce` and find no producer of `locals.nonce`.
**Fix scope:** small (drop `locals.nonce` fallback)
**Verification:** VERIFIED-code

### P2-VIEW-55 — Hardcoded English in `superadmin_order_new.ejs`, `admin_doctors.ejs`, `admin_alerts.ejs` headers
**Severity:** P2
**Category:** debt
**Location:** Many superadmin/admin views
**Description:** Page titles ("New Doctor", "Create Order", "Operations Dashboard"), KPI labels ("Total doctors", "Pending re-upload"), breadcrumbs ("Dashboard › Doctors") are hardcoded English. The patient + doctor portals are bilingual; admin/superadmin is English-only despite a `lang === 'ar'` branch existing at the top of several admin views.
**Impact:** Arabic-language admin staff cannot use the admin/superadmin portals natively.
**Fix scope:** large
**Verification:** VERIFIED-code

### P2-VIEW-56 — `appointment_availability.ejs` has no `<%- include('partials/footer'...) %>`
**Severity:** P2
**Category:** render
**Location:** src/views/appointment_availability.ejs:42
**Description:** File ends at line 41. The `partials/header.ejs` opened a `portal-shell` + `portal-grid` + `<main>` (via `layouts/portal.ejs`), but no closing footer-include is rendered. Sticky elements that depend on body-end script execution (Lucide init in footer.ejs:111-184) never run.
**Impact:** Lucide icons may not render on this page; portal sidebar nav delegators may not attach.
**Fix scope:** small (add `<%- include('partials/footer', { showFooter: false, portalFrame: true }) %>`)
**Verification:** VERIFIED-code

### P2-VIEW-57 — Many views set `locals.brand` defensively but `middleware.js:213` always provides it
**Severity:** P2
**Category:** debt
**Location:** Various — `intake_form.ejs:3`, `sandbox_order_intake.ejs:2`, `superadmin_order_new.ejs:4`, `doctor_login_v2.ejs:7`, `doctor_pending_approval.ejs:5`
**Description:** Every view re-reads `brand` with a `(typeof brand !== 'undefined' && brand) ? brand : 'Tashkheesa'` fallback. The middleware sets `res.locals.brand = process.env.BRAND_NAME || 'Tashkheesa'` so the fallback is dead. Code smell, not a bug.
**Impact:** None. Just noisy templates.
**Fix scope:** small
**Verification:** VERIFIED-code

### P3-VIEW-58 — `messages.ejs` polling `setInterval` lacks page-visibility / focus check
**Severity:** P3
**Category:** debt
**Location:** src/views/messages.ejs:253-269
**Description:** Polls `/api/messages/<id>/poll` every 5s regardless of tab visibility. Bell partial does this correctly (visibility check at line 372). Inconsistent.
**Impact:** Wastes server resources for backgrounded tabs.
**Fix scope:** small
**Verification:** VERIFIED-code

### P3-VIEW-59 — `messages.ejs` `currentUserId` interpolated as bare string in JS
**Severity:** P3
**Category:** xss
**Location:** src/views/messages.ejs:169
**Description:** `var currentUserId = '<%= _user.id %>';` — _user.id is a UUID from the DB. No quote-injection risk in practice but the safer pattern is `<%- JSON.stringify(_user.id) %>` (matching the bell partial / new_case wizard). Same for `conversationId` (line 168) and `lastMessageTime` (line 171).
**Impact:** Defensive only.
**Fix scope:** small
**Verification:** VERIFIED-code

### P3-VIEW-60 — `patient_records.ejs` and `messages.ejs` interpolate i18n strings via `<%= _isAr ? ... %>` inside JS string literals
**Severity:** P3
**Category:** xss
**Location:** src/views/patient_records.ejs:208, 234; src/views/messages.ejs:286-307
**Description:** `alert('<%= _isAr ? "هل أنت متأكد؟" : "Are you sure?" %>')` — interpolating server-side strings inside single-quoted JS literals. EJS HTML-escapes single-quotes to `&#039;`, breaking the JS literal if any future translation contains an apostrophe. The Arabic strings here are safe; the English fallbacks "Are you sure?" / "Title is required" are too. But "Patient's Notes" or any apostrophe would break the script (the EJS-escaped `&#039;` is not a valid character in a JS source literal).
**Impact:** Latent JS-syntax bug if a translator adds an apostrophe.
**Fix scope:** small (use `<%- JSON.stringify(L(...)) %>`)
**Verification:** VERIFIED-code

### P2-VIEW-61 — Patient v2 head includes `mobile-more-sheet` indirectly; no nonce passed
**Severity:** P2
**Category:** csp
**Location:** src/views/partials/patient/mobile-tabbar.ejs:51
**Description:** `mobile-tabbar.ejs` includes `mobile-more-sheet.ejs` without passing `cspNonce`. The sheet partial doesn't itself emit a `<script>` (the script is in foot.ejs), so this is currently fine. Flag for symmetry with VIEW-31.
**Impact:** None today.
**Fix scope:** small
**Verification:** VERIFIED-code

### P3-VIEW-62 — `partials/patient/icon.ejs` not read but referenced 50+ times
**Severity:** P3
**Category:** debt
**Location:** Across all patient v2 views
**Description:** Cannot audit content without reading file (not opened in this pass). Worth a follow-up audit since icon names are passed as strings (`name: 'home'`) and a typo would silently render nothing.
**Impact:** Possible silent missing icons.
**Fix scope:** small (audit pass)
**Verification:** NEEDS-VERIFICATION

### P2-VIEW-63 — `superadmin_doctors.ejs` not opened in this pass — render call passes only 6 locals; many features may have broken locals
**Severity:** P2
**Category:** render
**Location:** src/routes/superadmin.js:1935
**Description:** `res.render('superadmin_doctors', { user: req.user, doctors, specialties, statusFilter, pendingDoctorsCount, pausedDoctorsCount });` — view file not read; if it references stats/activity locals it will fall to typeof guards that may render zero values. Pairs with VIEW-53.
**Impact:** Possible zero-state KPIs on superadmin doctors page.
**Fix scope:** small (read view, confirm)
**Verification:** NEEDS-VERIFICATION

### P3-VIEW-64 — Specialty / blog / static views accessed via `static-pages.js` rely on `BUSINESS_INFO` injected as render local
**Severity:** P3
**Category:** render
**Location:** Multiple — services.ejs, contact.ejs, faq.ejs, etc.
**Description:** `BUSINESS_INFO` is passed as a local in every static-page render call. View files use `(typeof BUSINESS_INFO !== 'undefined' && BUSINESS_INFO) ? BUSINESS_INFO : {}`. Consistent and defensive. Note: routes pass it; if a future PR adds a new static page and forgets to pass it, the typeof guard prevents crash.
**Impact:** None.
**Fix scope:** none
**Verification:** VERIFIED-code

### P3-VIEW-65 — `error.ejs` dev-mode `verbose` `<pre>` echoes `__message` raw via `<%= %>` (HTML-escape only)
**Severity:** P3
**Category:** xss
**Location:** src/views/patient_500.ejs:47
**Description:** Dev-only block (gated by `NODE_ENV !== 'production'`) emits the raw error message inside `<pre>` via escaped output. Safe. Flag because if anyone changes `<%= __message %>` to `<%- __message %>`, untrusted error stack traces would render as live HTML.
**Impact:** Defensive note.
**Fix scope:** none
**Verification:** VERIFIED-code

### P2-VIEW-66 — `patient_records.ejs` script template-literal uses backticks but interpolates EJS via `${...}`
**Severity:** P2
**Category:** xss
**Location:** Out-of-scope spot — checking `help_me_choose.ejs:118` and `partials/service_assistant.ejs` use `${LANG === 'ar' ? ... }` inside `innerHTML` template literals
**Description:** These template literals inject untrusted strings into innerHTML. Safe today because `LANG` is server-set; but the pattern (innerHTML with backtick-interpolated values) is a footgun that survived even after multiple CSP/XSS reviews.
**Impact:** Defensive note.
**Fix scope:** medium (refactor to DOM ops)
**Verification:** VERIFIED-code

### P2-VIEW-67 — Sidebar partials in patient and doctor portals diverge: 3 implementations
**Severity:** P2
**Category:** debt
**Location:** `partials/patient_sidebar.ejs`, `partials/patient/sidebar.ejs`, `partials/doctor/sidebar.ejs`
**Description:** Three sidebar partials. `patient_sidebar.ejs` is legacy; `patient/sidebar.ejs` is v2. Some views still reach into the legacy one (e.g., `messages.ejs:59`).
**Impact:** Visual inconsistency; nav drift across patient pages.
**Fix scope:** medium
**Verification:** VERIFIED-code

### P3-VIEW-68 — `partials/admin_pills.ejs`, `partials/country_options.ejs`, `partials/user_menu.ejs`, `partials/doctor_header.ejs` not audited
**Severity:** P3
**Category:** debt
**Location:** Various partials
**Description:** Did not open these partials in this pass. Should be checked for inline scripts / forms / locals consumption in a follow-up.
**Impact:** Unknown.
**Fix scope:** small
**Verification:** NEEDS-VERIFICATION

### P3-VIEW-69 — `intake_form.ejs` line 8 falls back to `'Tashkheesa'` brand inside opened layout; possible double-rendered brand
**Severity:** P3
**Category:** debt
**Location:** src/views/intake_form.ejs:7-11
**Description:** View opens `portal-header` containing `brandSafe` after `partials/header` already opened the page (with portalFrame). Two brand banners may render simultaneously when an admin navigates here.
**Impact:** Visual duplication.
**Fix scope:** small
**Verification:** INFERRED

### P2-VIEW-70 — `error.ejs` does not include any portal/auth header; standalone HTML
**Severity:** P2
**Category:** debt
**Location:** src/views/error.ejs
**Description:** `error.ejs` is rendered through `<!DOCTYPE html>` directly with its own `<head>`. Doesn't load `portal-tours.css`, `lucide.css`, etc. Different look from the main app.
**Impact:** Disorienting for users; CSP-safe though (no inline scripts).
**Fix scope:** medium
**Verification:** VERIFIED-code

### P3-VIEW-71 — `forgot_password.ejs` localized error map (line 53-58) duplicates `auth.errors.*` translation keys defined elsewhere
**Severity:** P3
**Category:** debt
**Location:** src/views/forgot_password.ejs:53-58
**Description:** Hardcoded EN→AR map of error messages that should already exist in `i18n/en.json` / `ar.json`. If translation file gains a new key, this view doesn't.
**Impact:** Translation drift.
**Fix scope:** small
**Verification:** VERIFIED-code

### P2-VIEW-72 — `404.ejs` and `patient_404.ejs` and `error.ejs` and `patient_500.ejs` exist concurrently
**Severity:** P2
**Category:** debt
**Location:** src/views/404.ejs, patient_404.ejs, error.ejs, patient_500.ejs
**Description:** Four distinct error/not-found views. Resolution logic in `server.js:814` picks one. Unclear which is canonical for which path. Maintenance load × 4.
**Impact:** Inconsistent error-page UX across portal.
**Fix scope:** medium
**Verification:** INFERRED

### P3-VIEW-73 — `patient_walkthrough.ejs` reads `totalSteps` directly without typeof guard
**Severity:** P3
**Category:** render
**Location:** src/views/patient_walkthrough.ejs:785
**Description:** `var total = <%= totalSteps %>;` — if route ever omits `totalSteps`, EJS renders `var total = ;` which is a JS SyntaxError. Mitigated by `routes/help.js` always passing it (need to confirm — line 25 / 30 doesn't).
**Impact:** Latent. Worth verifying: `grep -n totalSteps routes/help.js` returns nothing — so this IS a bug if `patient_walkthrough` ever renders. Combined with VIEW-5 (no nonce on the surrounding script), the entire walkthrough is broken.
**Fix scope:** small
**Verification:** VERIFIED-code

### P3-VIEW-74 — `partials/patient/sidebar.ejs` "Cases" nav item routes to `/dashboard`, not a cases list
**Severity:** P3
**Category:** debt / a11y
**Location:** src/views/partials/patient/sidebar.ejs:48 (and same in mobile-tabbar.ejs:30)
**Description:** Comment on line 42 acknowledges this: `"My cases" routes to /dashboard until 2+ cases per patient is realistic — listing page deferred to Phase 6.` So clicking "My cases" while you're on the dashboard does nothing visible. Active state never differs between Home and My cases.
**Impact:** Confusing nav for patients with one case. UX debt accepted but should ship a deferred-state hint.
**Fix scope:** small
**Verification:** VERIFIED-code

### P2-VIEW-75 — `ops-dashboard.ejs` form `POST /ops/agent/toggle` has no CSRF (route IS exempted in `csrf.js:86`)
**Severity:** P2
**Category:** csrf
**Location:** src/views/ops-dashboard.ejs:337-340; src/middleware/csrf.js:86-88
**Description:** Confirmed: `csrf.js` exempts paths starting with `/ops/agent/`. So this is intentional. The risk: ops authentication itself protects these routes (`requireOpsAuth`), so a CSRF on the agent toggle would require the attacker to first acquire an ops session, at which point CSRF is moot. Documented decision but still a P2 risk: any reflected XSS or session-hijack on the ops portal can directly toggle production agents.
**Impact:** Defense-in-depth gap; documented.
**Fix scope:** medium (add CSRF to ops POSTs anyway)
**Verification:** VERIFIED-code


---

# Section 03 — Security deep-dive

# Security deep-dive — 2026-05-06

Scope: CSP, CSRF, auth, cookies, rate limiting, PII, injection, secrets, defense-in-depth.
Methodology: Read every file in `src/server.js`, `src/auth.js`, `src/middleware.js`, `src/middleware/csrf.js`, `src/middleware/requireJWT.js`, `src/middleware/requirePhone.js`, `src/routes/auth.js`, `src/routes/api/auth.js`, `src/routes/api_v1.js`, `src/routes/payments.js`, `src/routes/video.js`, `src/routes/ops.js`, `src/routes/admin.js`, `src/routes/intake.js`, `src/routes/ai_assistant.js`, `src/storage.js`, `src/services/national-id.js`, plus a sample of EJS views and grep sweeps for SQL/redirect/logging anti-patterns. All findings link to `path/to/file.js:line`.

---

## CSP

### P0-SEC-1 — Two competing CSPs: helmet sets `'unsafe-inline'`, second handler overwrites with strict nonce
**Severity:** P1
**Category:** csp
**Location:** src/middleware.js:14-71 and src/server.js:231-253
**Description:** `baseMiddlewares()` registers helmet with a CSP that includes `'unsafe-inline'` for both `script-src` and `style-src`. Then a separate middleware at `src/server.js:231` builds a *different* CSP (with `'nonce-…'` and no `'unsafe-inline'`) and calls `res.setHeader('Content-Security-Policy', csp)`. Because the second middleware runs later it overwrites helmet's header — net effect: only the strict nonce policy ships. That is the policy you *want*, but the duplicate config is brittle: anyone who reorders middleware or moves logic into helmet's options block (the obvious "consolidate" refactor) instantly drops the nonce and re-enables `'unsafe-inline'`.
**Impact:** Latent regression risk. A future cleanup can quietly downgrade to `'unsafe-inline'` script-src — i.e. a free XSS-on-stored-data sink — with no test catching it.
**Fix scope:** small (delete helmet's CSP block; configure helmet with `contentSecurityPolicy: false` and keep the inline nonce middleware as the single source of truth)
**Verification:** VERIFIED-code

### P0-SEC-2 — `connect-src` whitelist drops Twilio (`wss://*.twilio.com`); video calls cannot reach signaling server
**Severity:** P1
**Category:** csp
**Location:** src/server.js:246
**Description:** Strict CSP ships `connect-src 'self' https://upload.uploadcare.com https://api.uploadcare.com https://ucarecdn.com`. Helmet's variant *does* include `wss://*.twilio.com` and `https://*.twilio.com` (src/middleware.js:45-52), but helmet's CSP is overwritten (P0-SEC-1). Twilio video-call signaling will be blocked in any browser that respects the served policy.
**Impact:** Video consultation feature broken in production. Operationally a feature bug, but listed under security because it's a CSP-policy mismatch.
**Fix scope:** small
**Verification:** VERIFIED-code

### P1-SEC-3 — Inline scripts in views ship without `nonce` attribute; will be blocked by the strict CSP
**Severity:** P1
**Category:** csp
**Location:** src/views/help_me_choose.ejs:106, src/views/patient_walkthrough.ejs:783, src/views/video_appointment.ejs:197, src/views/ops-dashboard.ejs:391, src/views/doctor_signup.ejs:363, src/views/partials/service_assistant.ejs:225
**Description:** The strict CSP (`script-src 'self' 'nonce-…' …`) blocks any `<script>…</script>` tag without the matching nonce. These EJS templates emit inline `<script>` blocks with no `nonce="<%= cspNonce %>"` attribute. Either the pages render with broken JS, or these pages haven't been hit in prod yet so the gap is invisible.
**Impact:** Functional break (intake wizard, doctor signup, ops dashboard countdown, walkthrough, video booking flow). Not directly a security risk but advertises the CSP isn't holistically tested — an attacker can probe for CSP-misconfigured endpoints to spot which pages still allow inline JS regressions.
**Fix scope:** medium (audit every EJS, add `nonce="<%= cspNonce %>"` to every `<script>` block)
**Verification:** VERIFIED-code

### P2-SEC-4 — `style-src` retains `'unsafe-inline'` defeating the rest of the strict policy
**Severity:** P2
**Category:** csp
**Location:** src/server.js:244
**Description:** `style-src 'self' 'unsafe-inline' https://ucarecdn.com https://fonts.googleapis.com`. With `'unsafe-inline'` for styles, an attacker who lands stored content in a CSS context can do data exfiltration (CSS injection / attribute readers). Inline styles can also be used as exfil channels (CSS background-image with controlled URL). Modern best practice is nonce-or-hash style-src.
**Impact:** Defense-in-depth gap. Limited exploit surface in this app, but the strict CSP has effectively no style-side protection.
**Fix scope:** medium (add nonces to style tags, or migrate inline `style=…` attribute usage to classes)
**Verification:** VERIFIED-code

### P3-SEC-5 — Dead nonce helper `src/middleware-nonce-fix.js` still imported but never wired
**Severity:** P3
**Category:** csp
**Location:** src/middleware-nonce-fix.js, imported at src/middleware.js:1 (`addNonceMiddleware`)
**Description:** Module exports `addNonceMiddleware` which writes `res.locals.nonce`. The import sits unused; the live nonce path is in `src/server.js:231-253` (writes `res.locals.cspNonce` and `req.cspNonce`). The two names (`nonce` vs `cspNonce`) led to the recent EJS partial bugs. Templates already do `locals.cspNonce || locals.csp_nonce || locals.nonce` to bridge — but the dead helper makes it look like there's a second nonce source.
**Impact:** Confuses anyone reading the middleware stack. Risk of a future PR re-enabling the helper which would generate a *different* nonce per response, breaking the strict CSP again.
**Fix scope:** small (delete file + import)
**Verification:** VERIFIED-code

### P3-SEC-6 — `frame-ancestors 'none'` set, but `X-Frame-Options DENY` is also set — duplicates are redundant but harmless
**Severity:** P3
**Category:** headers
**Location:** src/server.js:153, src/server.js:241
**Description:** Both anti-clickjacking headers present, which is the intended belt-and-braces. No issue — flagging only because the prompt asked for confirmation.
**Impact:** None.
**Fix scope:** none
**Verification:** VERIFIED-code

---

## CSRF

### P0-SEC-7 — Entire `/api/v1/*` surface exempt from CSRF and protected only by Bearer JWT in Authorization header — CORS is wildcard
**Severity:** P0
**Category:** csrf
**Location:** src/middleware/csrf.js:80-82, src/routes/api_v1.js:36-42
**Description:** CSRF middleware exempts any path starting with `/api/v1`. The mobile API also sets `Access-Control-Allow-Origin: '*'`. This is OK *only* if no `/api/v1/*` route accepts cookie-based session auth — and it doesn't (the requireJWT middleware reads the `Authorization: Bearer …` header only). However: the *web* portal session JWT and the *mobile* JWT are signed with the **same secret** (src/middleware/requireJWT.js:13-14 and src/auth.js:39 both use `process.env.JWT_SECRET`) and the access-token TTL is 15 min on mobile but 7 days on web. A web user with a valid 7-day session-cookie JWT could in principle have it lifted via XSS or open-redirect into a Bearer header and replayed against `/api/v1`. The `requireRole('patient')` gate on the protected mount restricts impact to patient-scoped data, but mobile and web share the same sign() schema (same `id`/`role`/`email` shape) so the role check passes.
**Impact:** Cookie-bearing JWT works as Bearer token. Combined with `Access-Control-Allow-Origin: '*'` an attacker JS in a third-party site cannot read the cookie but *can* exfiltrate the access token if it ever leaks into the page. Hard to weaponize directly, but the contract — "different auth surfaces, same key, same payload schema" — eliminates the "stolen cookie ≠ stolen API token" boundary you'd normally have.
**Fix scope:** medium (separate signing keys for portal vs API, OR at minimum add an `aud` claim and check it on the API side)
**Verification:** VERIFIED-code

### P0-SEC-8 — `/payments/callback` and `/portal/video/payment/callback` exempt from CSRF by path prefix match — exemption is too broad
**Severity:** P1
**Category:** csrf
**Location:** src/middleware/csrf.js:83-85
**Description:** `if (p === '/callback' || p.startsWith('/portal/video/payment/callback') || p.startsWith('/payments/callback')) return next();` Both `/portal/video/payment/callback` and `/payments/callback` are HMAC-verified webhooks (src/routes/payments.js:198-237 and src/routes/video.js:288-296), so they don't *need* CSRF tokens. But: the `startsWith` match means `/payments/callback-anything-suffix` is also exempt forever — if anyone ever mounts a sibling route under `/payments/callback*`, it will be CSRF-exempt by accident. The audit prompt asked specifically about `/callback` (a top-level path with no namespace) — that one *also* matches `p === '/callback'` and is exempt. Verifying: `src/routes/payments.js:193 router.post('/callback', …)` is mounted at `app.use('/payments', paymentRoutes)` so the live path is `/payments/callback`, not `/callback`. The bare `/callback` exemption is dead — but it's still a footgun (a stray top-level handler at `/callback` would get CSRF-exempted by accident).
**Impact:** Latent: a future route accidentally placed under one of these prefixes inherits CSRF exemption silently. Webhook HMAC is the actual auth; CSRF is defense-in-depth, but the exemption pattern is dangerously permissive.
**Fix scope:** small (replace `startsWith` with exact-equal matches; delete the dead `'/callback'` arm)
**Verification:** VERIFIED-code

### P1-SEC-9 — Ops dashboard endpoints (`/ops/agent/ping`, `/ops/agent/log-tokens`) are CSRF-exempt AND auth-exempt
**Severity:** P1
**Category:** csrf
**Location:** src/middleware/csrf.js:86-99, src/routes/ops.js:654-707
**Description:** CSRF middleware blanket-exempts `/ops/agent/*`. The route handlers `/ops/agent/ping` and `/ops/agent/log-tokens` have **no auth gate** — anyone on the internet can POST arbitrary `agent_name`, `status`, `current_task`, `tokens_used`, `cost_usd`, `task_label` and have them written to `agent_heartbeats` and `agent_token_log`. Field length capped (200/500/2000 chars) so it's not an SQL-injection vector, but it's an unauthenticated insert into operational-tracking tables.
**Impact:** Garbage-data/economic-DoS: an attacker can flood `agent_token_log` with high `cost_usd` values to trigger your token-spend alerts and confuse operations. Could also enumerate agent names via timing.
**Fix scope:** small (add a shared-secret header check or move under `requireOpsAuth`)
**Verification:** VERIFIED-code

### P1-SEC-10 — `/ops/login` exempt from CSRF — credential-stuffing form is unsigned
**Severity:** P1
**Category:** csrf
**Location:** src/middleware/csrf.js:90, src/routes/ops.js:164-199
**Description:** `/ops/login` POST is in the CSRF exemption list. With CSRF exempt and the cookie not constrained by SameSite (it's set with `sameSite: 'lax'` post-login, but the *attempt* arrives before any cookie exists), an attacker site can submit a form to `/ops/login` from any origin. Because the form submits creds (not auth-cookie-based), CSRF wouldn't normally protect a login form anyway — *however*, the in-memory rate limiter at `src/routes/ops.js:132-152` is per-IP and a CSRF-enabled form would at least force the attempt to come from an authenticated browser context. Bigger concern: `LOGIN_ATTEMPTS` is per-process in-memory (line 116), and on Render with multiple instances each instance has its own counter — making the "5 attempts → 15 min lockout" trivially bypassable by load-balancer fan-out.
**Impact:** Attacker-driven cross-origin POSTs to `/ops/login` for distributed credential stuffing; per-instance lockout = effective 5×N attempts where N = number of running instances.
**Fix scope:** medium (wire CSRF on the form, move login attempts to Redis/DB)
**Verification:** VERIFIED-code

### P1-SEC-11 — CSRF cookie not rotated on login or logout; same token survives privilege change
**Severity:** P1
**Category:** csrf
**Location:** src/middleware/csrf.js:32-44, src/routes/auth.js:1006-1016
**Description:** `ensureCsrfCookie` only generates a token if one doesn't exist. There is no rotation on `POST /login`, `POST /logout`, role escalation, or password reset. The same `csrf_token` cookie persists across login boundaries for 7 days. CSRF protection still works (any forged request still needs the *current* token), but if the token leaks via a referer or browser history before login, it remains valid for the new session — undermining session-fixation hardening.
**Impact:** Token stickiness across auth events. A leaked CSRF token from a public-internet pre-login session (e.g. behind a shared corporate proxy that logs Cookie headers) remains valid after the user logs in.
**Fix scope:** small (regenerate `csrf_token` on login/logout success)
**Verification:** VERIFIED-code

### P1-SEC-12 — CSRF mode silently degrades to log-only when `CSRF_MODE` env unset in dev — risk if NODE_ENV mis-set in prod
**Severity:** P2
**Category:** csrf
**Location:** src/middleware/csrf.js:27-29
**Description:** `CSRF_MODE` defaults to `'enforce'` only when `MODE === 'production' || MODE === 'staging'`. Otherwise it defaults to `'log'`. If `MODE` is mis-spelled or unset on a Render deploy (Render uses `NODE_ENV` and `MODE` is read from `process.env.MODE`), CSRF silently downgrades. There is no boot-time assertion that confirms enforcement.
**Impact:** Single config slip flips CSRF off in prod. No alarm.
**Fix scope:** small (require `CSRF_MODE === 'enforce'` when `process.env.MODE !== 'development'`, fail-closed)
**Verification:** VERIFIED-code

### P2-SEC-13 — `csrfField()` helper writes raw HTML via `<%- %>` — only safe because `cookieToken` is hex-only
**Severity:** P3
**Category:** csrf
**Location:** src/middleware/csrf.js:105
**Description:** `res.locals.csrfField = function() { return '<input type="hidden" name="_csrf" value="' + cookieToken + '">'; };` Token is `randomBytes(32).toString('hex')`, always 64 hex chars, so this is currently safe. Flagging because the pattern is inherently injection-prone if the token format ever changes.
**Impact:** None today. Brittle to future changes.
**Fix scope:** small (HTML-escape inside the helper for defensive coding)
**Verification:** VERIFIED-code

---

## Auth

### P0-SEC-14 — JWT cookie TTL (7d) wildly outlives access-token use; no refresh + revocation, no `iat`/`jti` tracking
**Severity:** P1
**Category:** auth
**Location:** src/auth.js:39-42, src/routes/auth.js:116, src/routes/auth.js:248-254
**Description:** Portal session is a 7-day JWT with no refresh-token rotation. `src/middleware/requireJWT.js:60-78` does have access (15m) + refresh (30d) tokens for the mobile API, with rotation on every refresh — that's the right shape. But the *portal* session is a flat 7-day token, no sliding window, no rotation, no refresh. There is no token-blacklist on logout: `POST /logout` only clears the cookie (src/routes/auth.js:1014). A stolen cookie value remains valid for the full 7 days regardless of logout, password change, or role change. There is also no `jti` or `iat`-based invalidation, so even rotating `JWT_SECRET` would log everyone out as the only revocation mechanism.
**Impact:** Cookie theft → 7-day attacker session. Password reset doesn't invalidate prior sessions.
**Fix scope:** medium (introduce token-version column on `users`; embed `tv` in JWT; bump `tv` on logout/password-reset; check on every requireRole)
**Verification:** VERIFIED-code

### P0-SEC-15 — `password_reset_tokens` are not single-use atomically — small window for token replay
**Severity:** P1
**Category:** auth
**Location:** src/routes/auth.js:497-563, src/routes/api/auth.js:369-415
**Description:** Token validation (`findValidToken`) reads `used_at`; the consume step writes `used_at = NOW()`. Reads and writes are not in the same transaction — between the read and the UPDATE another concurrent POST with the same token could pass validation. Severity is dampened because the validation/consume pair is generally fast and an attacker would need to win a tight race, but with `await` boundaries between the queries (e.g. the `bcrypt.hash` step in `/api/v1/auth/reset-password` is ~100ms during which the token is still "unused") the window is non-trivial.
**Impact:** Two concurrent reset attempts with the same stolen token both succeed → attacker and victim both believe they own the new password.
**Fix scope:** small (use `UPDATE password_reset_tokens SET used_at = NOW() WHERE token = $1 AND used_at IS NULL RETURNING user_id` and reject if rowCount=0)
**Verification:** VERIFIED-code

### P0-SEC-16 — Mobile-API `/api/v1/auth/login` lacks the doctor `pending_approval` / `is_active` gate that the portal enforces
**Severity:** P1
**Category:** auth
**Location:** src/routes/api/auth.js:91-124, contrast with src/routes/auth.js:236-244
**Description:** Mobile login filters `WHERE … AND role = 'patient'` so doctors can't sign in via mobile (good). But the schema-of-bypass concern remains — the mobile login does **not** check `is_active`. Any patient row with `is_active=false` (e.g. account deactivated by admin via `POST /admin/doctors/:id/toggle-active` — which is doctor-only here, but an analogous patient-disable surface exists) can still authenticate via mobile.
**Impact:** Account-deactivation control bypass via mobile API. Currently moot for doctors, but the pattern is fragile — any future patient-disable mechanism won't propagate.
**Fix scope:** small (add `AND is_active = true` to the SELECT)
**Verification:** VERIFIED-code

### P1-SEC-17 — No login-attempt rate limiting per identity (per-IP only) — credential stuffing across many IPs not throttled
**Severity:** P1
**Category:** auth
**Location:** src/middleware.js:88-98 (authLimiter), src/routes/auth.js:207-275
**Description:** `authLimiter` caps 30 attempts per IP per 15 min on `/login`, `/forgot-password`, `/reset-password`. No per-email throttling. An attacker rotating IPs can credential-stuff `victim@example.com` indefinitely. There is also no account lockout on N consecutive failures.
**Impact:** Credential stuffing not detected by the rate limiter. Bcrypt cost of 10 (~80ms) gates raw throughput, but a 1000-attempt run distributed across 100 IPs lands inside the 30/IP/15min window with room to spare.
**Fix scope:** medium (track `failed_login_attempts` per email in DB; lock after threshold with exponential backoff)
**Verification:** VERIFIED-code

### P1-SEC-18 — Refresh token rotation revokes only the *currently presented* token, not all sessions
**Severity:** P2
**Category:** auth
**Location:** src/routes/api/auth.js:128-156
**Description:** Mobile refresh stores the latest refresh token on `users.refresh_token` (single column). On a fresh login or refresh, the previous token is overwritten. If a refresh token leaks, the legitimate user logging in (which overwrites the column) does invalidate the attacker — good. But if the *attacker* refreshes first, the legitimate user's stored token is overwritten and *they* are logged out without warning. There's no audit log of the rotation, no way to detect "two devices fighting over a single refresh slot."
**Impact:** Silent account takeover via refresh-token theft, with the legitimate user just seeing "session expired."
**Fix scope:** medium (multi-row refresh-token table with device fingerprint; alert on refresh-from-stale-token)
**Verification:** VERIFIED-code

### P1-SEC-19 — `attachUser` sets `req.user` from JWT without checking against the live DB; deactivated/role-changed users keep access for up to 7 days
**Severity:** P1
**Category:** auth
**Location:** src/auth.js:85-104, src/middleware.js:186-222
**Description:** Both `attachUser` (auth.js) and the parallel `baseMiddlewares` user-attach block trust the JWT payload directly. There is no per-request DB lookup to verify the user still exists, is_active, or has the role claimed. Comments at src/middleware.js:257-261 explicitly defend this as a perf optimization. With no token-version invalidation (P0-SEC-14), a deactivated doctor remains a doctor for the full token TTL.
**Impact:** Deactivation, role demotion, and account deletion don't take effect until the cookie expires.
**Fix scope:** medium (light-cache live user state with short TTL, or invalidate via token-version field — same fix as P0-SEC-14)
**Verification:** VERIFIED-code

### P1-SEC-20 — Two parallel auth middleware stacks attach `req.user` differently; risk of inconsistency
**Severity:** P2
**Category:** auth
**Location:** src/auth.js:85-104 (`attachUser`) wired at src/server.js:308; src/middleware.js:186-222 wired via `baseMiddlewares()` at src/server.js:222
**Description:** Both middlewares set `req.user` from the same cookie but via different code paths (attachUser uses `getTokenFromRequest` which falls back to `req.cookies.token/auth/jwt/access_token/accessToken`; baseMiddlewares reads only `req.cookies[SESSION_COOKIE]`). The order is: baseMiddlewares first, then attachUser. attachUser overwrites. If attachUser fails to recognise a cookie that baseMiddlewares accepted (or vice versa), there's drift. The `attachUser` fallback to `c.token / c.auth / c.jwt / c.access_token / c.accessToken` is also a footgun — if any of those names are also legitimate cookies, JWT verification on a non-JWT value silently fails to no-op (line 47 `catch{return null}`).
**Impact:** Silent auth state drift. Confusion when debugging "why isn't my user attached." No active exploit, but the multiple cookie names increase the attack surface for cookie smuggling.
**Fix scope:** medium (delete one of the two attach paths; pin to a single cookie name)
**Verification:** VERIFIED-code

### P2-SEC-21 — Bcrypt cost factor 10 — borderline acceptable in 2026, no Argon2/Scrypt path
**Severity:** P2
**Category:** auth
**Location:** src/auth.js:6-8, src/routes/api/auth.js:68, src/routes/api/auth.js:391, src/create_test_doctor.js:19
**Description:** Cost-10 bcrypt is ~80ms on commodity hardware — OK for a hot login path but on the low end. OWASP 2024 guidance is bcrypt cost 12+ or Argon2id. No migration path planned.
**Impact:** Faster offline cracking if `users.password_hash` is ever exfiltrated.
**Fix scope:** small (raise cost to 12; keep verify-only support for cost-10 hashes via `bcrypt.compare`)
**Verification:** VERIFIED-code

### P2-SEC-22 — `safeNextPath` blocks `//foo` and `https://` but not protocol-relative tricks via path normalization
**Severity:** P2
**Category:** auth
**Location:** src/routes/auth.js:182-193
**Description:** `if (!raw.startsWith('/')) return null; if (raw.startsWith('//')) return null;` rejects standard open-redirect bait. But `/\foo` (single backslash) is allowed and some proxies will normalize it to `//foo` post-redirect. Also no check for `\t`/`\r`/`\n` in the path which can split headers (Express's `res.redirect` does sanitize Location, mitigating). Finally, the function is local to `auth.js` — `src/routes/admin.js:2153-2155` re-implements its own `next` validation locally with simpler rules (`next.startsWith('/') && !next.startsWith('//')`) — same brittleness, copy-pasted.
**Impact:** Marginal. Most edge cases are caught downstream by Express.
**Fix scope:** small (centralize one `safeNextPath` and call from both auth.js and admin.js)
**Verification:** VERIFIED-code

### P2-SEC-23 — `verifyRefreshToken` doesn't check token type cryptographically — relies on `decoded.type === 'refresh'`
**Severity:** P2
**Category:** auth
**Location:** src/middleware/requireJWT.js:85-93
**Description:** Refresh and access tokens are signed with the same secret, distinguished only by a `type` claim. An attacker who somehow obtains an access token (which is short-lived, but still) cannot use it as a refresh token because the `type !== 'refresh'` check rejects it. Conversely, presenting a refresh token to `requireJWT` as a Bearer would fail the role check (refresh has no `role`). So in practice this is OK, but the design is fragile — separate signing keys per token type would be more robust.
**Impact:** Defense-in-depth gap. Hard to weaponize today.
**Fix scope:** medium (introduce `JWT_REFRESH_SECRET` distinct from `JWT_SECRET`)
**Verification:** VERIFIED-code

### P3-SEC-24 — `refreshSessionCookie` reads `process.env.NODE_ENV` for `secure` flag while everywhere else reads `MODE`
**Severity:** P3
**Category:** auth
**Location:** src/auth.js:138-151
**Description:** `const isProd = process.env.NODE_ENV === 'production'`. Most of the codebase reads `process.env.MODE`. If `MODE=production` but `NODE_ENV` is unset, the rotated cookie ships `secure: false` while the original was `secure: true` — quietly downgrading the rotated session.
**Impact:** Cookie sent over HTTP after rotation in misconfigured environments.
**Fix scope:** small (use `MODE` consistently)
**Verification:** VERIFIED-code

### P3-SEC-25 — `req.session` referenced in 5+ places but no session middleware is installed
**Severity:** P3
**Category:** auth
**Location:** src/server.js:273,288,748; src/middleware.js:197,203; src/routes/intake.js:14; src/routes/superadmin.js:79,1118
**Description:** No `express-session` registration is present. All `req.session` access is guarded with `req.session && …`, so it's a no-op. The `intake.js` `requirePatientLogin` *does* reference `req.session.userId` as a fallback — that fallback is dead, but if someone later adds express-session the dead path becomes live (`getLoggedInPatient` would trust a session-stored userId without further checks).
**Impact:** None today. Trap for the next person who adds sessions.
**Fix scope:** small (delete dead session-fallback paths)
**Verification:** VERIFIED-code

---

## Cookie flags

### P2-SEC-26 — `lang` cookie set with `httpOnly: false` (necessary, ok) but `secure` flag not set in middleware.js variant
**Severity:** P2
**Category:** headers
**Location:** src/middleware.js:206-208, contrast with src/routes/auth.js:38-44 and src/routes/lang.js:36-40
**Description:** When `?lang=` is set on a request, `baseMiddlewares` re-issues the `lang` cookie via `res.cookie('lang', lang, { maxAge: …, httpOnly: false })` — no `secure`, no `sameSite`. The other places that set the lang cookie (`auth.js`, `lang.js`) do set `secure` + `sameSite='lax'`. So the cookie's flags depend on which path issued it.
**Impact:** Lang cookie exposed over HTTP if a downgrade attack is mounted; only relevant to language preference (low value), but it's a cookie-flag inconsistency.
**Fix scope:** small (align all three lang-cookie writers)
**Verification:** VERIFIED-code

### P3-SEC-27 — `last_path` cookie tracks every GET URL with `httpOnly: false`
**Severity:** P3
**Category:** headers
**Location:** src/server.js:419-433
**Description:** Tracks the last visited authenticated URL for redirect-after-login. `httpOnly: false` so client JS can read it. Could leak `?id=…` or `?token=…` query params from authenticated paths to any XSS payload that lands.
**Impact:** Minor info leak via XSS; the cookie itself is non-auth.
**Fix scope:** small (`httpOnly: true` — the redirect logic is server-side anyway)
**Verification:** VERIFIED-code

### P3-SEC-28 — `ops_auth` cookie uses `secure: process.env.NODE_ENV === 'production'` directly — not aligned with `MODE`
**Severity:** P3
**Category:** headers
**Location:** src/routes/ops.js:188-193
**Description:** Same drift as P3-SEC-24; if `MODE=production` but `NODE_ENV` is unset, the ops cookie ships in cleartext.
**Impact:** Ops session cookie over HTTP.
**Fix scope:** small (read MODE)
**Verification:** VERIFIED-code

---

## Rate limiting

### P1-SEC-29 — No rate limit on `/api/v1/auth/otp/request` — SMS/WhatsApp pumping vector
**Severity:** P1
**Category:** auth
**Location:** src/routes/api/auth.js:160-198, mounted under `authLimiter` at src/routes/api_v1.js:71
**Description:** `authLimiter` caps 20/IP/15min for the whole `/api/v1/auth/*` namespace. That's 80 OTP-send requests/hour per IP, each hitting Twilio Verify (paid) for any phone number the attacker types. No per-phone-number rate limit. An attacker can iterate through phone numbers (`+201000000000`, `+201000000001`, …) at 20/15min/IP × N IPs and burn your Twilio credit at scale, or spam-pump a target's phone.
**Impact:** Direct economic-DoS on Twilio Verify spend; harassment of arbitrary phone numbers.
**Fix scope:** medium (per-phone limit: max 3 OTPs / 15 min for the same `phone`)
**Verification:** VERIFIED-code

### P1-SEC-30 — `/api/help-me-choose` (Anthropic-backed) limits only 20/IP/min — no per-user limit, no daily cap
**Severity:** P1
**Category:** secrets
**Location:** src/routes/ai_assistant.js:77-86, mounted globally
**Description:** Each request calls `client.messages.create` (Sonnet 4) with up to 10 messages × 500 chars + ~5KB catalog system prompt. 20 req/min/IP × 60 min × 24h × N IPs ≈ trivial to burn through your Anthropic budget. No daily cap, no per-conversation cap, no auth required.
**Impact:** Direct economic-DoS on Anthropic spend.
**Fix scope:** medium (require auth; per-user daily cap; budget-circuit-breaker that returns 503 if monthly token spend exceeds threshold)
**Verification:** VERIFIED-code

### P1-SEC-31 — Ops login rate limit is per-process in-memory map; trivially bypassed on multi-instance Render deploy
**Severity:** P1
**Category:** auth
**Location:** src/routes/ops.js:116, src/routes/ops.js:132-156
**Description:** `LOGIN_ATTEMPTS = {}` is a module-level in-memory object. Render web services run multiple instances behind a load balancer; each instance has its own counter. With 2 instances, the effective lockout is 10 attempts; with 4 instances, 20.
**Impact:** Ops-portal credential stuffing isn't actually rate-limited at the published threshold.
**Fix scope:** medium (Redis-backed counter, or DB-backed)
**Verification:** VERIFIED-code

### P2-SEC-32 — Global rate limiter (100/min/IP) applied via `app.use(limiter)` — does not differentiate authenticated vs unauthenticated
**Severity:** P2
**Category:** auth
**Location:** src/middleware.js:77-84
**Description:** All requests share a single 100/IP/min budget. Power users behind shared NAT (corporate, schools, mobile carriers) can hit this on legitimate use. Conversely, an attacker with botnet IPs is unaffected.
**Impact:** Friction for legitimate users; no real attacker mitigation.
**Fix scope:** medium (skip authenticated requests; tighten unauthenticated; or use a sliding window keyed on user-id when present)
**Verification:** VERIFIED-code

### P2-SEC-33 — `validate: false` on every rate limiter — disables express-rate-limit's misconfiguration guards
**Severity:** P3
**Category:** auth
**Location:** src/middleware.js:80,91,105,122,134,146,158,170,180; src/routes/api_v1.js:50,60; src/routes/order_flow.js:33; src/routes/ai_assistant.js:80
**Description:** Every limiter sets `validate: false`. That disables the library's `trust proxy` correctness check (which warns when `app.set('trust proxy')` is misconfigured and the limiter is using the wrong remote IP). With `app.set('trust proxy', 1)` in server.js:147 the default trust-proxy=1 is fine on Render's single-hop proxy, but disabling validation means future regressions go unnoticed.
**Impact:** Hidden misconfig risk if proxy hops change.
**Fix scope:** small (remove `validate: false` once)
**Verification:** VERIFIED-code

---

## PII handling

### P0-SEC-34 — `national_id` decryption uses a string-comparison key in the SQL — leaks via pg statement timing if logged
**Severity:** P2
**Category:** pii
**Location:** src/services/national-id.js:53-57, src/routes/auth.js:918
**Description:** `pgp_sym_decrypt(national_id_encrypted, $1)` passes the encryption key as parameter `$1`. Postgres protocol parameters are NOT logged in `pg_stat_statements` (good — only the parameterized SQL text is). However, if `log_statement='all'` is ever enabled, the *parameter values* land in `postgresql.log`. Render Postgres has `log_statement='none'` by default but a future operator turning it on for diagnostics would leak the master key on every doctor-onboard. There's also no key-rotation plan. Comment at auth.js:894-897 acknowledges the parameterization protects pg_stat_statements but doesn't address logs.
**Impact:** Encryption key in plaintext in DB logs if `log_statement` ever changes. No key rotation = a single key compromise leaks every doctor's national ID forever.
**Fix scope:** large (move encryption to application layer using AWS KMS / GCP KMS; remove pgcrypto dependency)
**Verification:** VERIFIED-code

### P1-SEC-35 — `notification_worker.js` DRY_RUN logs full email + phone in plaintext
**Severity:** P1
**Category:** pii
**Location:** src/notification_worker.js:119, src/notification_worker.js:159
**Description:** `console.log('[notify-worker][DRY_RUN] Would send email', { to: user.email, … })` and `… { to: user.phone, … }`. DRY_RUN is gated on env, but if it's ever flipped on in prod for diagnostics, every patient email + phone hits the structured log stream (Render captures stdout to permanent log storage).
**Impact:** Bulk PII export to logs.
**Fix scope:** small (use `maskEmail` + `maskPhone` from src/utils/mask.js — they're already imported in src/notify/whatsapp.js)
**Verification:** VERIFIED-code

### P1-SEC-36 — Twilio Verify logs full phone number in success and stub paths
**Severity:** P1
**Category:** pii
**Location:** src/services/twilio_verify.js:48,60,90
**Description:** `console.log('[TWILIO VERIFY STUB] Credentials not set. OTP not sent to:', phone, …)` and `console.log('[TWILIO VERIFY] Sent OTP to ${phone}, status: …')`. Phone numbers in plaintext in logs.
**Impact:** PII (phone) in log archive; mappable to user via DB join.
**Fix scope:** small (wrap with maskPhone)
**Verification:** VERIFIED-code

### P1-SEC-37 — Static-pages contact and pre-launch handlers log email + name unmasked
**Severity:** P1
**Category:** pii
**Location:** src/routes/static-pages.js:213,262
**Description:** `console.log('[CONTACT] New message from %s <%s> — subject: %s', name, email, …)` and same pattern for pre-launch leads. Both are explicitly user-supplied PII flowing through to log storage.
**Impact:** PII in log archive.
**Fix scope:** small (mask email; drop name from logs or hash it)
**Verification:** VERIFIED-code

### P1-SEC-38 — `src/create_test_doctor.js` prints email + plaintext password + curl command-with-creds to stdout
**Severity:** P1
**Category:** secrets
**Location:** src/create_test_doctor.js:62-67
**Description:** Operational seed script that creates `dr.ahmed@tashkheesa.com` with `Doctor123!` and a curl-with-cleartext-password to log in. The script is committed and the credential is hardcoded. Even if only ever run in dev, the password lives in repo history forever and a future re-run against prod (the script ALSO does `UPDATE users SET password_hash = … WHERE email = $1` if the row exists — it'll silently overwrite a real doctor's password if `dr.ahmed@tashkheesa.com` exists in prod) silently re-pins a known credential.
**Impact:** Hardcoded backdoor into any environment where this script is run, including by CI accidentally. A leaked DATABASE_URL run with this script logs in any environment with a known cred.
**Fix scope:** small (delete the script; use seed data tooling that generates random passwords and emails them)
**Verification:** VERIFIED-code

### P2-SEC-39 — `forgot-password` and superadmin `reset-link` print full reset URLs in dev logs (gated on `!IS_PROD`)
**Severity:** P3
**Category:** secrets
**Location:** src/routes/auth.js:312-315, src/routes/superadmin.js:2873-2876
**Description:** Reset link logged via `console.log('[RESET LINK]', resetLink)` only when `!IS_PROD`. Prior audit flagged this; gating is in place. Flagging because: `IS_PROD` is derived from `MODE`/`NODE_ENV`, both of which are in scope of P3-SEC-24 / P2-SEC-12 — a misconfig flips the flag and leaks reset links to permanent logs.
**Impact:** One env-var slip → reset-link harvest.
**Fix scope:** small (assert IS_PROD at module init based on multi-source check; never log links if any env signal is ambiguous)
**Verification:** VERIFIED-code

### P2-SEC-40 — Email + name passed verbatim to `res.cookie` and `res.locals` without ever calling sanitizeString — XSS risk if any view renders unescaped
**Severity:** P2
**Category:** pii
**Location:** src/routes/auth.js:579-691, src/views/admin.ejs:335
**Description:** Registration accepts `name` with no length cap and no HTML-strip (just a `.trim()` and a country regex). Once stored, several admin views render via `<%= name %>` (escaped — safe) but `src/views/admin.ejs:335` renders `<%- o.doctor_name || '<span class="cell-muted">Unassigned</span>' %>` (raw — unescaped). A doctor who registers with `name = '<script>fetch("/admin/doctors").then(…)</script>'` gets stored XSS that fires for every admin viewing the orders list.
**Impact:** Stored XSS in admin dashboard via doctor self-registration `name` field. CSP would block inline `<script>` (good), but `<img onerror=…>` is allowed unless `img-src` is locked down (it allows `data:` and external CDN — but inline event handlers are blocked under strict CSP without `'unsafe-inline'`). So the strict CSP mitigates it, but the moment CSP regresses (P0-SEC-1) it lights up.
**Fix scope:** small (escape `o.doctor_name` — use `<%= %>` and lift the `Unassigned` fallback into a separate ternary block; also add an HTML-tag-strip in registration validators)
**Verification:** VERIFIED-code

### P3-SEC-41 — `users.refresh_token` stored as the literal token (not hashed) — DB compromise = active session takeover
**Severity:** P2
**Category:** auth
**Location:** src/routes/api/auth.js:79,116,150,276
**Description:** Mobile refresh tokens are stored verbatim in `users.refresh_token`. A read-only DB compromise (e.g. `SELECT` injection) yields valid 30-day refresh tokens for every active mobile user. Compare to passwords (bcrypt-hashed). Standard practice: store `sha256(refreshToken)` and compare hashes.
**Impact:** DB read = mobile session hijack.
**Fix scope:** small (store hash; compare hash on lookup)
**Verification:** VERIFIED-code

### P3-SEC-42 — `signed download URL` `ResponseContentDisposition` filename uses caller-controlled value with only quote/CRLF strip
**Severity:** P3
**Category:** pii
**Location:** src/storage.js:69-76, src/server.js:406-407
**Description:** `safeName = String(downloadName).replace(/["\r\n]/g, '')`. Allows `;` which terminates the header value early. R2/AWS will URL-encode the filename in the signed URL anyway, so this is mostly cosmetic; flagging because the input is user-controlled (file label in DB is set by patient/doctor upload metadata).
**Impact:** Header injection theoretically possible via `;` in filename; AWS SDK should encode.
**Fix scope:** small (RFC 6266 / RFC 5987 encoding; or whitelist `[A-Za-z0-9._-]`)
**Verification:** INFERRED

---

## Injection

### P2-SEC-43 — Dynamic SQL in `admin.js`, `doctor.js` constructs `SET` clause from a code-controlled list (not user input) — safe but pattern-fragile
**Severity:** P3
**Category:** injection
**Location:** src/routes/admin.js:2541, src/routes/doctor.js:3689, src/routes/doctor.js:4139
**Description:** `await execute('UPDATE service_regional_prices SET ' + sets.join(', ') + …, params)`. The `sets` array is populated by literal column names in code, never from `req.body`. No injection today, but the pattern (`SET ${joined}`) is exactly the shape attackers grep for. One copy-paste away from `sets.push(reqColumn + …)`.
**Impact:** None today; high regression-risk pattern.
**Fix scope:** small (a tiny helper `buildUpdate(table, allowedFields, body)` that whitelists keys)
**Verification:** VERIFIED-code

### P2-SEC-44 — `ops.js:534` builds `LIMIT $X OFFSET $Y` via string concatenation against the param array — safe but double-check pattern
**Severity:** P3
**Category:** injection
**Location:** src/routes/ops.js:528-535
**Description:** `'… LIMIT ' + limitParam + ' OFFSET ' + offsetParam` where `limitParam`/`offsetParam` are `'$N'` placeholders. Values are pushed to `queryParams`. Safe. Flagging because the next person editing this might reach for `'… LIMIT ' + perPage` directly.
**Impact:** None today.
**Fix scope:** small (use parameterized form throughout)
**Verification:** VERIFIED-code

### P2-SEC-45 — XSS via raw `<%- … %>` rendering of `doctor_name`, `patient_name`, `service_name` in admin views
**Severity:** P2
**Category:** injection
**Location:** src/views/admin.ejs:335, src/views/superadmin_doctor_form.ejs:178-179, multiple `*.ejs.bak` (dead but tracked)
**Description:** See P2-SEC-40 for admin.ejs. Also `superadmin_doctor_form.ejs:178-179` injects raw `_optionsJson` and `_selectedJson` into `<textarea>` content. JSON-stringified output inside a textarea is generally safe, but if either value contains `</textarea>…` literally (encoded JSON allows this — `JSON.stringify` does NOT escape `</textarea>`), the tag closes early. Mitigated by CSP, but injecting raw HTML into textareas is a long-standing footgun.
**Impact:** Stored XSS via uncontrolled JSON content.
**Fix scope:** small (post-process JSON.stringify with `.replace(/</g, '\\u003c')` before raw-rendering)
**Verification:** VERIFIED-code

### P3-SEC-46 — `.bak` view files tracked in git: `doctor_alerts.ejs.bak`, `portal_doctor_profile.ejs.bak`, `patient_reviews.ejs.bak`, `patient_appointments_list.ejs.bak`, `doctor_case_intelligence.ejs.bak`, `doctor_analytics.ejs.bak`, `patient_prescription_detail.ejs.bak`, `patient_referrals.ejs.bak`, `patient_alerts.ejs.bak`
**Severity:** P3
**Category:** injection
**Location:** src/views/*.ejs.bak
**Description:** `.gitignore` line 71 says `*.bak` is ignored, but multiple `.bak` files are already tracked (committed before the rule). They contain old versions of the EJS views — some with raw `<%-` interpolations on user data (e.g. `doctor_analytics.ejs.bak:170` raw-renders `charts.monthlyRevenue`). These files are not rendered by the running app (EJS resolves `*.ejs` only), but they confuse audits and may be re-introduced by a future rename.
**Impact:** Audit noise; risk of accidental re-deployment.
**Fix scope:** small (`git rm` the .bak files)
**Verification:** VERIFIED-code

---

## Secrets handling

### P1-SEC-47 — `JWT_SECRET` is the SAME secret signing portal sessions, mobile access tokens, mobile refresh tokens, AND ops-dashboard cookies
**Severity:** P1
**Category:** secrets
**Location:** src/auth.js:39, src/middleware/requireJWT.js:13, src/routes/ops.js:114
**Description:** A single `process.env.JWT_SECRET` signs four token classes with very different security postures (web 7d session, mobile 15m access, mobile 30d refresh, ops 12h). Compromise of any one signs all four. Rotating the secret to revoke any one class invalidates all of them. There's no `kid` (key id) header to support graceful rotation.
**Impact:** Single-key compromise = total auth blast radius. No rotation strategy.
**Fix scope:** medium (per-class secrets: `JWT_SECRET_PORTAL`, `JWT_SECRET_API_ACCESS`, `JWT_SECRET_API_REFRESH`, `OPS_JWT_SECRET`)
**Verification:** VERIFIED-code

### P1-SEC-48 — `UNSUBSCRIBE_SECRET` falls back to hardcoded `'tash-unsub-dev-only'` outside production
**Severity:** P2
**Category:** secrets
**Location:** src/routes/campaigns.js:14-22
**Description:** Production fails closed — good. Staging and dev fall back to literal `'tash-unsub-dev-only'`. Anyone who has read the repo can mint valid unsubscribe tokens for any user-id in any non-prod environment. If staging mirrors prod data (it sometimes does for QA), unsubscribe-spam is trivial.
**Impact:** Marketing-list integrity attack in any non-prod environment that touches real email addresses.
**Fix scope:** small (fail closed in staging too; only allow fallback when `MODE === 'development'`)
**Verification:** VERIFIED-code

### P3-SEC-49 — `DATABASE_URL` is masked via `replace(/\/\/.*@/, '//<credentials>@')` in boot log — works for `protocol://user:pass@host` but not for query-string creds
**Severity:** P3
**Category:** secrets
**Location:** src/server.js:84
**Description:** Mask handles `postgres://user:pass@host`. Doesn't handle `postgres://host?password=…&user=…` (rare but Render-supported). No issue today since Render uses the standard form.
**Impact:** None today.
**Fix scope:** small (full-URL parse + mask only password)
**Verification:** VERIFIED-code

---

## Defense-in-depth / headers

### P0-SEC-50 — No HSTS header set
**Severity:** P1
**Category:** headers
**Location:** src/server.js:150-158 (baseline header block)
**Description:** No `Strict-Transport-Security` header anywhere. Helmet's default would emit `max-age=15552000; includeSubDomains` — but helmet's CSP path is the only thing wired (and as noted in P0-SEC-1, helmet is partially overridden). The baseline header block in server.js sets `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`, `Permissions-Policy` — but no HSTS.
**Impact:** First-load downgrade to HTTP possible (user types `tashkheesa.com` not `https://`). MITM can strip `https://` until cookie-based auth is established.
**Fix scope:** small (`res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload')` in production-only)
**Verification:** VERIFIED-code

### P1-SEC-51 — No HTTP→HTTPS redirect; relies on Render's edge enforcement
**Severity:** P2
**Category:** headers
**Location:** src/server.js (no such handler)
**Description:** No `if (req.protocol === 'http') redirect to https`. Render does enforce HTTPS at the edge by default, so this is OK in production. But: any other deployment target (Docker on bare VPS, on-prem) has no protection, and the fact that the trust-proxy / `req.secure` / `x-forwarded-proto` logic exists in payment-callback URL building (src/routes/payments.js:111) shows the codebase already handles the proxy header — it just doesn't enforce.
**Impact:** Render-edge dependency. Misdeployment = HTTP-served site.
**Fix scope:** small
**Verification:** VERIFIED-code

### P2-SEC-52 — `Permissions-Policy` blocks geolocation/microphone/camera but doesn't mention payment, usb, fullscreen, etc.
**Severity:** P3
**Category:** headers
**Location:** src/server.js:156
**Description:** Restrictive on the named directives only. Modern recommended set adds: `payment=()`, `usb=()`, `accelerometer=()`, `gyroscope=()`, `magnetometer=()`, `autoplay=()`, `display-capture=()`.
**Impact:** Defense-in-depth gap.
**Fix scope:** small
**Verification:** VERIFIED-code

### P2-SEC-53 — `Referrer-Policy: same-origin` set, but `cross-origin-opener-policy` and `cross-origin-resource-policy` missing
**Severity:** P3
**Category:** headers
**Location:** src/server.js:152
**Description:** No COOP/CORP/COEP. Helmet's defaults *would* set these, but helmet's CSP override (P0-SEC-1) doesn't reset COOP/CORP. Verifying whether helmet's other defaults still ship: helmet's other defaults are header-by-header `setHeader`, which the per-request CSP block (server.js:231-253) doesn't touch. So COOP/CORP probably *are* set by helmet — but it's not explicit and the audit relies on helmet not regressing.
**Impact:** Spectre / cross-window-info-leak hardening depends on a transitive dep version.
**Fix scope:** small (set explicitly)
**Verification:** INFERRED

### P3-SEC-54 — `process.env.MODE` and `process.env.NODE_ENV` are inconsistently used to gate security flags
**Severity:** P2
**Category:** secrets
**Location:** src/server.js (uses MODE), src/auth.js:141 (uses NODE_ENV), src/routes/ops.js:190 (uses NODE_ENV), src/routes/auth.js:13 (uses both)
**Description:** Cookie `secure` flag, log gating, CSRF mode, dev-only console.logs — each consults a different combination of `MODE`, `NODE_ENV`, `RENDER_SERVICE_NAME`. A single environment var slip flips a different security control depending on which file you're in.
**Impact:** No single source of truth for "are we in production." Easy to misdeploy with one flag missing.
**Fix scope:** medium (single `src/env.js` exporting `IS_PROD`/`IS_STAGING`/`IS_DEV` — read once at boot, freeze)
**Verification:** VERIFIED-code

### P3-SEC-55 — `app.set('trust proxy', 1)` is hardcoded — fragile if Render adds a second proxy hop
**Severity:** P3
**Category:** headers
**Location:** src/server.js:147
**Description:** `1` means "trust 1 hop." Render uses 1 hop today. If Cloudflare or another proxy is ever added, the IP-based rate limiters will all read Cloudflare's IP as the client IP and bucket the entire internet into one limit.
**Impact:** Operational risk.
**Fix scope:** small (env-driven `TRUST_PROXY_HOPS`)
**Verification:** VERIFIED-code

---

## Misc / cross-cutting

### P1-SEC-56 — `/api/v1/*` mobile API CORS is `Access-Control-Allow-Origin: '*'` despite using bearer auth
**Severity:** P1
**Category:** csrf
**Location:** src/routes/api_v1.js:36-42
**Description:** Wildcard CORS plus `Access-Control-Allow-Headers: 'Content-Type, Authorization'` allows any origin to send Authorization-bearing requests. Browsers won't send credentials via cookies under wildcard, but they *do* allow Authorization header from any origin if the JS has the token. So if a token leaks into 3rd-party JS context (e.g. via XSS, or a dev-tools paste), any malicious site can replay it from a victim browser. The comment says "wildcard is intentional for React Native mobile clients" — but RN ignores CORS entirely (no browser), so a wildcard isn't *needed* for RN. Web origins can be restricted.
**Impact:** API tokens usable from any origin once obtained.
**Fix scope:** small (allow only `null` origin (mobile) and your specific domains; reject `*` from any web context)
**Verification:** VERIFIED-code

### P2-SEC-57 — `requireRole('superadmin')` for `/admin/doctors/:id/national-id` is correct, but the audit-log INSERT precedes the fetch — if INSERT fails the request 500s and never reaches the data, but if the INSERT *succeeds* with a nonexistent doctorId we still record an "access" that didn't happen
**Severity:** P3
**Category:** pii
**Location:** src/routes/admin.js:1783-1819
**Description:** The "fail-closed: no log, no view" comment claims atomicity but the order is INSERT→getDecryptedNationalId. If the latter throws, we return 500 with a stale audit row claiming the admin viewed the ID. Minor but the audit log integrity matters for PHI access.
**Impact:** False-positive audit entries.
**Fix scope:** small (insert audit row with status, update on success)
**Verification:** VERIFIED-code

### P2-SEC-58 — Order-files signed URL redirect (`/files/:fileId`) returns 302 to R2 with 1-hour TTL — token in URL leaks via browser history
**Severity:** P2
**Category:** pii
**Location:** src/server.js:357-413
**Description:** `signedUrl` is sent as `res.redirect(302, signedUrl)`. The full signed URL (with R2 query-string credentials) lands in browser history, referer headers when the user clicks a link inside the downloaded PDF (if it opens inline), and any analytics that capture URL.
**Impact:** PHI download URLs leak via referer/history. 1h validity bounds the impact.
**Fix scope:** medium (proxy the file through the server instead of redirect; or shorten TTL to ~5 min)
**Verification:** VERIFIED-code

### P3-SEC-59 — `Math.random()` used in `referrals.js` referral-code generation and `db.js` order-event id generation
**Severity:** P3
**Category:** secrets
**Location:** src/routes/referrals.js:19, src/db.js:394,446, src/routes/api/cases.js:401
**Description:** Referral codes (`TASH-XXXXX` over a 32-char alphabet, 5 chars) have ~25 bits entropy. Math.random() in V8 is xorshift128+, predictable from a few outputs. Codes are looked up against a unique index (`SELECT id FROM referral_codes WHERE code = $1`) so collision retry exists, but a determined attacker can pre-compute candidate codes faster than the rate limiter (`/api/referral` 10/IP/min) tolerates. Order-event ids use `Date.now() + Math.random()` — millisecond timestamp + 8 random base36 chars (~40 bits) for a non-security identifier. OK in isolation but contributes to the "seeded RNG everywhere" pattern.
**Impact:** Marketing referral attribution can be brute-forced; not a direct security vuln.
**Fix scope:** small (`crypto.randomBytes` everywhere — already used in 90% of the codebase)
**Verification:** VERIFIED-code

### P3-SEC-60 — `intake.js` `generateTempPassword` produces `Tk!{12hex}7aA` — only 48 bits of effective entropy
**Severity:** P3
**Category:** auth
**Location:** src/routes/intake.js:91-95
**Description:** Fixed prefix `Tk!`, fixed suffix `7aA`, only 12 hex chars are random. 48 bits = 2.8e14 — bcrypt-cost-10 puts brute-force at ~30000 years on a single GPU, so practically safe today. But the fixed prefix/suffix means any leak of a single temp password (e.g. in a log, a CI seed dump) reveals the entire generation pattern. Path is reachable only when `findOrCreatePatient` creates a new patient via intake (which requires already being a logged-in patient — see logic at intake.js:122-138 — so the path is dead today). Still flagging.
**Impact:** Predictable structure. Dead-path today.
**Fix scope:** small (`randomBytes(16).toString('base64url')` directly; or delete the function since the path is unreachable)
**Verification:** VERIFIED-code

### P3-SEC-61 — Boot-time `validateCriticalEnvVars` checks 3 vars but misses `PAYMOB_HMAC_SECRET`, `R2_ACCESS_KEY_ID`, `NATIONAL_ID_ENCRYPTION_KEY`
**Severity:** P2
**Category:** secrets
**Location:** src/server.js:51-68
**Description:** Required list is `['JWT_SECRET', 'DATABASE_URL', 'ANTHROPIC_API_KEY']`. Missing: `PAYMOB_HMAC_SECRET` (without it, the webhook returns 503 — payments silently break), `NATIONAL_ID_ENCRYPTION_KEY` (without it, doctor signup 500s), `R2_*` (without them, all file uploads fail). The boot succeeds with these missing; user-visible failures appear at runtime.
**Impact:** Silent boot success masks broken payment/upload paths.
**Fix scope:** small (extend the required list)
**Verification:** VERIFIED-code

### P2-SEC-62 — `email` field in registration form is normalized via `.trim().toLowerCase()` but not validated as RFC 5321 — accepts `<script>` in local-part if cookie-parser passes it
**Severity:** P3
**Category:** injection
**Location:** src/routes/auth.js:586-622
**Description:** `validatePhoneE164` is called for phone but no `validateEmail` exists — registration relies on the column-level UNIQUE constraint and downstream usage. Bcrypt + DB queries don't care, but the email is later embedded into welcome emails as `to:` (where the email transport will reject malformed addresses) and into views via `<%= email %>` (escaped — safe). Lower-priority; flagging as a hole in the validator surface.
**Impact:** Garbage data in users.email; email-send failures.
**Fix scope:** small (`isEmail` from express-validator on portal route too — already used in mobile API)
**Verification:** VERIFIED-code

### P3-SEC-63 — `ops.js` `sshExec` interpolates `cmd` into a shell with `replace(/"/g, '\\"')` — fragile escape
**Severity:** P3
**Category:** injection
**Location:** src/routes/ops.js:29-40
**Description:** `var sshCmd = 'ssh … ' + user + '@' + host + ' "' + cmd.replace(/"/g, '\\"') + '"'`. Only escapes `"`. `$`, backticks, and `\` survive — but the `cmd` is hardcoded in code today (only `pgrep -f openclaw …`). If anyone later passes a user-controlled string through `sshExec`, it's a remote-command-injection on the SSH target.
**Impact:** None today; high regression-risk.
**Fix scope:** small (use `child_process.execFile` with array args)
**Verification:** VERIFIED-code

### P2-SEC-64 — Body parser limit is 1MB on JSON+urlencoded but 5MB on `/api/v1/*` JSON
**Severity:** P3
**Category:** csrf
**Location:** src/middleware.js:73-74, src/routes/api_v1.js:30
**Description:** Mobile API allows 5MB JSON bodies. Combined with no per-endpoint limit, and the Anthropic-backed `/api/help-me-choose` (which is mounted at portal level, 1MB), an attacker can submit large-message payloads to most endpoints. 1MB is reasonable; 5MB on the API for what should be small JSON is overlarge.
**Impact:** Memory pressure during request flood; per-request multer overhead absorbing large payloads.
**Fix scope:** small (drop `/api/v1` JSON limit to 1MB; raise only on specific upload endpoints)
**Verification:** VERIFIED-code

---

## Out of scope but flagged

- The audit prompt mentions a known issue: "/payments/callback exempt may be a typo for /payments/webhook." Confirmed not a typo — the route lives at `POST /payments/callback` (src/routes/payments.js:193 mounted at `/payments`). It's HMAC-verified. The CSRF exemption is correct in intent but uses `startsWith` (P0-SEC-8).
- The previous audit's "superadmin temp password leak" appears fixed in the current code — `console.log('[RESET LINK]', …)` is gated by `!IS_PROD` (auth.js:312, superadmin.js:2873). The `IS_PROD` derivation drift (P3-SEC-24, P3-SEC-39) is the lingering concern.


---

# Section 04 — Order state machine audit

# Order State Machine Audit (2026-05-06)

Scope: `orders.status` lifecycle, `payment_status`, SLA breach/reassignment, doctor accept/complete, refund, and the worker/web paths that mutate them.

---

## State-transition table

Canonical enum lives in `case_lifecycle.js:632-646` (DRAFT, SUBMITTED, PAID, ASSIGNED, IN_REVIEW, REJECTED_FILES, COMPLETED, SLA_BREACH, REASSIGNED, CANCELLED). `STATUS_TRANSITIONS` map is at `case_lifecycle.js:709-723`.

| From | To | Actor / Trigger | Condition | Site |
|---|---|---|---|---|
| (none) | DRAFT | patient new-case wizard | `createDraftCase` | `case_lifecycle.js:1298-1314` |
| DRAFT | SUBMITTED | patient step5 (legacy) / `submitCase` | sets payment_due_at = +24h | `case_lifecycle.js:1316-1326` |
| DRAFT/SUBMITTED | `expired_unpaid` | unpaid-reminder sweep | elapsed >=24h, payment_status != paid | `case_lifecycle.js:521-533` |
| DRAFT/SUBMITTED | soft-deleted (`deleted_at`+`expired_unpaid`) | unpaid-reminder sweep | elapsed >=48h | `case_lifecycle.js:544-587` |
| SUBMITTED | PAID | Paymob webhook → `markCasePaid` | hmac-verified, `payment_status='paid'` first set in route | `routes/payments.js:357-413`, `case_lifecycle.js:1328-1397` |
| SUBMITTED/`unpaid` | PAID (via raw status change to `'new'`) | superadmin mark-paid | non-canonical write `status='new'` | `routes/superadmin.js:2429-2467` |
| SUBMITTED | PAID (stub) | patient `/payment-success?stub=1` (non-live) | direct UPDATE + `markCasePaid` | `routes/patient.js:1791-1828` |
| PAID | ASSIGNED | `assignDoctor` (auto-assign / superadmin / broadcast accept) | payment confirmed | `case_lifecycle.js:1771-1875` |
| ASSIGNED/PAID/SUBMITTED/`new`/`accepted` | `in_review` (raw) | doctor accept handler | raw UPDATE — bypasses canonical guard | `routes/doctor.js:1942-1957` |
| ASSIGNED | REASSIGNED → ASSIGNED | `reassignCase` (SLA breach / accept timeout / superadmin reassign) | various | `case_lifecycle.js:1877-1976`, `case_sla_worker.js:231-326`, `routes/superadmin.js:2684-2715` |
| IN_REVIEW | SLA_BREACH (canonical) | `markSlaBreach` | accepted_at + sla_hours < now | `case_lifecycle.js:1399-1470` |
| IN_REVIEW/ASSIGNED | `breached` (raw, non-canonical) | `performSlaCheck` & server.js sweep & `sla_watcher.js` & `sla_status.js` | `deadline_at < now` | `routes/superadmin.js:558-565`, `server.js:1074`, `sla_watcher.js:119-126`, `sla_status.js:58-66` |
| IN_REVIEW/ASSIGNED | REJECTED_FILES (canonical) or `rejected_files` (raw) | `markOrderRejectedFiles` (admin-approval gated) OR doctor portal direct UPDATE | varies | `case_lifecycle.js:1589-1645`, `routes/doctor.js:2129-2133` |
| `rejected_files` | `awaiting_files` (non-canonical) | superadmin approves additional-files request | raw UPDATE — non-canonical | `routes/superadmin.js:1806-1812` |
| IN_REVIEW | COMPLETED | doctor generates report | raw UPDATE in fallback | `routes/doctor.js:4098-4174` |
| any | CANCELLED | superadmin cancel | raw UPDATE — patient cancel route does NOT exist | `routes/superadmin.js:2718-2762` |
| `breached` | `assigned`/`submitted` (raw) | superadmin extend-sla | un-breach when extending | `routes/superadmin.js:2780-2783` |

---

## Findings

### P0-STATE-1 — Doctor accept route bypasses canonical lifecycle, writes non-canonical `'in_review'`
**Severity:** P0 | **Category:** state | **Location:** `src/routes/doctor.js:1942-1957` | **Description:** The doctor's accept handler does a raw `UPDATE orders SET status='in_review'` instead of calling `caseLifecycle.transitionCase(..., IN_REVIEW)`. It bypasses `assertCanonicalDbStatus`, `assertPaidGate`, `closeOpenDoctorAssignments`, `case_events` lifecycle log, and the `notifyCaseAssigned` flow. It writes `'in_review'` (lowercase, non-canonical) — every other write path uses canonical `IN_REVIEW`. | **Impact:** Mixed casing in DB; `transitionCase` guards (payment-gate, deadline backfill, doctor_assignments closure) are skipped; an unpaid order can be moved to in_review if some upstream path admitted it. Also after acceptance the route immediately calls `markSlaBreach(orderId)` (line 2004) which is wrong — it just accepted, deadline is future, but the call relies on `markSlaBreach` short-circuiting. | **Fix scope:** medium | **Verification:** VERIFIED-code

### P0-STATE-2 — Three independent SLA breach implementations write `'breached'` (non-canonical) to status
**Severity:** P0 | **Category:** state/race | **Location:** `src/routes/superadmin.js:558-565`, `src/server.js:1074`, `src/sla_watcher.js:119-126`, `src/sla_status.js:58-66` | **Description:** Four separate code paths set `status='breached'` (lowercase) directly via raw SQL, in parallel with `case_lifecycle.markSlaBreach` which writes canonical `SLA_BREACH`. The worker `case_sla_worker.js` calls `markSlaBreach` (canonical) but `server.js`'s `runSlaReminderJob` and `routes/superadmin.js performSlaCheck` write `'breached'` directly. None of the raw paths use `transitionCase`. | **Impact:** Status normalisation works (alias maps `breached` → SLA_BREACH) but: no `case_events` row, no auto-reassign through canonical reassign helper, and the four sweeps can race each other. The legacy paths also hit `superadmin.js:618` which sets `status='new'` (non-canonical) and resets `accepted_at=NULL` and `deadline_at=NULL` after auto-reassigning — a doctor who accepts the next moment lands on a brand new SLA window with no event trail of the prior breach. | **Fix scope:** large (delete the 3 legacy paths, keep `case_sla_worker` only) | **Verification:** VERIFIED-code

### P0-STATE-3 — No patient-cancel-with-refund flow exists
**Severity:** P0 | **Category:** payment/lifecycle | **Location:** searched `src/routes/patient.js` — no cancel endpoint | **Description:** Searched `routes/patient.js` for `cancel` and `delete`; the only matches are notification status filters and dashboard rendering. There is no patient-initiated cancel route. Only superadmin can cancel (`routes/superadmin.js:2718`), and that path does NOT call `issueBreachRefund` or any refund helper — it just sets `status='cancelled'`. | **Impact:** Patient who pays and changes mind has no self-service cancellation. Superadmin cancel after payment leaves money on the order with no refund record. The refund-row gates (`issueBreachRefund`) are only hooked from SLA-breach sweeps. | **Fix scope:** large | **Verification:** VERIFIED-code

### P0-STATE-4 — Status `'awaiting_files'` is undocumented & not in canonical enum but written by superadmin
**Severity:** P0 | **Category:** state | **Location:** `src/routes/superadmin.js:1808` and consumed in `case_sla_worker.js:24`, `superadmin.js:478`, `selectSlaRelevantOrders` | **Description:** Superadmin "approve additional files" writes `status='awaiting_files'` via raw UPDATE. This value is NOT in `CASE_STATUS`, NOT in `STATUS_ALIASES`, NOT in `CASE_STATUS_UI`, and NOT in `DB_STATUS_VARIANTS`. It would fail `assertCanonicalDbStatus` if anyone tried `transitionCase`. Yet `case_sla_worker.ACTIVE_STATUSES` and `selectSlaRelevantOrders` include it. | **Impact:** Cases stuck in this in-between status will never re-enter canonical lifecycle (no transition wired back). `getStatusUi('awaiting_files')` returns the empty fallback — patient/doctor see raw text. SLA breach detection runs against it but reassignment cannot land it back in IN_REVIEW. | **Fix scope:** medium (alias to REJECTED_FILES OR add as canonical state with full UI/transition coverage) | **Verification:** VERIFIED-code

### P1-STATE-5 — Race: payment webhook + superadmin mark-paid + stub-success can each call `markCasePaid` concurrently with no global guard
**Severity:** P1 | **Category:** race/payment | **Location:** `routes/payments.js:404`, `routes/patient.js:1795`, `routes/superadmin.js:2406-2467` | **Description:** `markCasePaid` itself uses `withTransaction` + `SELECT ... FOR UPDATE` and is idempotent on lifecycle (`case_lifecycle.js:1331-1397`). But the surrounding routes also UPDATE `payment_status='paid'` outside that transaction (e.g. payment route does the UPDATE first at line 357, THEN calls `markCasePaid`; superadmin path does its UPDATE at 2429 then never calls `markCasePaid` — see P1-STATE-7). If two paths fire near-simultaneously, only the lifecycle is locked; the `payment_status` writes can interleave with side-effect-only differences. | **Impact:** Two `payment_method` strings can land (manual then gateway races); referral_redemptions UPDATE and notifications fire twice; auto-assign queued twice. | **Fix scope:** medium | **Verification:** VERIFIED-code

### P1-STATE-6 — Superadmin mark-paid does NOT call `markCasePaid` — bypasses the canonical PAID transition
**Severity:** P1 | **Category:** payment/lifecycle | **Location:** `src/routes/superadmin.js:2406-2551` | **Description:** Path sets `payment_status='paid'`, `paid_at`, then if status was an "awaiting payment" string, sets `status='new'` (non-canonical). It does NOT call `caseLifecycle.markCasePaid`, so: (1) `sla_hours` is never enforced (would fail invariant in canonical path), (2) no `PAYMENT_CONFIRMED` event, (3) no `dispatchSlaReminders`, (4) no payment-reminder cancellation, (5) `status` does not advance to canonical PAID. | **Impact:** Manually-paid orders never enter the canonical PAID state; downstream filters that look for canonical PAID skip them; doctor auto-assign code at superadmin.js:2481-2511 still runs because it only checks `payment_status='paid'`, but it picks doctor by raw column update without going through `assignDoctor` (no `doctor_assignments` row, no canonical ASSIGNED status). | **Fix scope:** medium | **Verification:** VERIFIED-code

### P1-STATE-7 — Superadmin reassign does not invoke canonical `reassignCase`; orphans earnings & skips SLA fresh window
**Severity:** P1 | **Category:** state/race | **Location:** `src/routes/superadmin.js:2684-2715` | **Description:** Raw UPDATE: `doctor_id = newDoctor.id, reassigned_count++`. Bypasses `case_lifecycle.reassignCase` which (a) marks original doctor's pending earnings row as `'reassigned'` and writes 10% partial-pay (`P1-FIN-2`), (b) closes open `doctor_assignments`, (c) checks auto-pause, (d) creates new `doctor_assignments` row with `accept_by_at`, (e) writes `reassignment_reason`, (f) notifies the original doctor. None of that happens via this superadmin path. | **Impact:** The original doctor still has `pending` earnings on this case — when the new doctor completes, both rows could mature to `paid` (financial duplication). New doctor has no fresh `accept_by_at` window so the SLA worker won't auto-time-out them. `reassigned_to_doctor_id`/`reassignment_reason` never set. | **Fix scope:** small (replace raw UPDATE with `caseLifecycle.reassignCase(orderId, newDoctorId, { reason: 'superadmin_manual' })`) | **Verification:** VERIFIED-code

### P1-STATE-8 — Doctor reject-files in routes/doctor.js bypasses canonical guard, no admin approval, no patient notify suppression
**Severity:** P1 | **Category:** state/lifecycle | **Location:** `src/routes/doctor.js:2110-2150` | **Description:** Doctor's portal reject-files endpoint does a raw `UPDATE orders SET status='rejected_files'`. It does NOT call `markOrderRejectedFiles` (which is the canonical admin-approval-gated path with `pauseSla`, `triggerNotification` admin-only). The doctor here flips the case directly with no admin approval and no SLA pause — the deadline keeps ticking while patient is asked for files. | **Impact:** Patient sees "more info needed" but SLA still expires; no admin approval signal recorded; deadline-based breach fires while waiting on patient. Earnings and reassignment race on a fast SLA tier. | **Fix scope:** medium | **Verification:** VERIFIED-code

### P1-STATE-9 — `resumeSla` is exported but never invoked anywhere
**Severity:** P1 | **Category:** lifecycle | **Location:** `src/case_lifecycle.js:1559-1587` (declaration & export) | **Description:** `grep -rn "resumeSla(" src/` returns only the declaration. After `pauseSla` runs (on REJECTED_FILES), nothing calls `resumeSla` when the patient uploads new files. The patient upload route at `routes/patient.js` does not dispatch a resume. | **Impact:** Once SLA is paused, `sla_paused_at` stays set forever even after files arrive; deadline_at never recomputed; SLA scanner skips the case (REJECTED_FILES is in scan list but the deadline is stale). Cases can sit in REJECTED_FILES indefinitely. | **Fix scope:** medium | **Verification:** VERIFIED-code

### P1-STATE-10 — SLA sweeps don't filter `deleted_at IS NULL` — soft-deleted orders are scanned/breached
**Severity:** P1 | **Category:** lifecycle/race | **Location:** `src/case_lifecycle.js:1496-1504` (`sweepSlaBreaches`), `case_sla_worker.js:169-180` (`fetchSlaCandidates`), `sla_watcher.js:33-40`, `server.js:1037` and `1064` (`runSlaReminderJob`), `routes/superadmin.js:482-491` | **Description:** The unpaid-reminder sweep soft-deletes orders with `deleted_at = $1` at the 48h mark (`case_lifecycle.js:548`). None of the SLA breach/reminder sweeps include `AND deleted_at IS NULL`. Only `routes/api/cases.js` filters deleted_at. | **Impact:** A soft-deleted (auto-deleted) order that somehow has a deadline still gets breached, breach refund fired, breach notifications queued to deleted patient. Paid+soft-deleted is unlikely (auto-delete only fires on unpaid 48h) but possible if `deleted_at` is used for any other purpose. Mostly: noise & wasted work. | **Fix scope:** small | **Verification:** VERIFIED-code

### P1-STATE-11 — Doctor capacity auto-reassign in accept handler bypasses canonical reassign — same orphan-earnings as P1-STATE-7
**Severity:** P1 | **Category:** state/payment | **Location:** `src/routes/doctor.js:1907-1937` | **Description:** When the accepting doctor is over capacity, the route does a raw `UPDATE orders SET doctor_id = nextDoctor.id` and redirects. No `reassignCase` call. Same financial impact as P1-STATE-7 (no partial-pay row, no pause check, no notifications). Only `case_auto_reassigned_capacity` event is logged. | **Impact:** Original doctor (the one over-capacity) was never the assigned doctor here so no orphan earnings; but the new doctor never gets an `accept_by_at` window or notification — they may not see the case at all. | **Fix scope:** small | **Verification:** VERIFIED-code

### P1-STATE-12 — `markSlaBreach` requires currentStatus = IN_REVIEW but most production paths breach from `'breached'` (non-canonical) or other states
**Severity:** P1 | **Category:** state | **Location:** `src/case_lifecycle.js:1233-1239` | **Description:** `transitionCase` enforces `if (desiredStatus === SLA_BREACH) { if (![IN_REVIEW].includes(currentStatus)) throw }`. But routes can hold cases in raw `'breached'`, `'awaiting_files'`, or `'rejected_files'` — `markSlaBreach` will throw for the first because alias maps `breached`→SLA_BREACH (current==desired triggers idempotent return at line 1429). For ASSIGNED→breach, the worker's `handleBreach` calls `markSlaBreach` which will throw. | **Impact:** SLA breaches against ASSIGNED (doctor never accepted but deadline set anyway via legacy path) silently fail and are logged as fatal in `case_sla_worker.js:371`. The reassignment then never happens through the canonical helper. | **Fix scope:** small (allow ASSIGNED in the assertTransition for SLA_BREACH) | **Verification:** VERIFIED-code

### P1-STATE-13 — `payment_status='refunded'` is a permitted superadmin write but does NOT update `status` or fire any refund-row insert
**Severity:** P1 | **Category:** payment | **Location:** `src/routes/superadmin.js:2610-2656` | **Description:** Unified `/superadmin/orders/:id/payment` endpoint allows `payment_status='refunded'`. The handler updates the column and logs an event, but: (a) no `INSERT INTO refunds`, (b) no `status` change to CANCELLED or terminal, (c) no Paymob refund call, (d) no `urgency_uplift_amount` zeroing, (e) no doctor earnings recompute. | **Impact:** Manual refund leaves the case in any state (could still be IN_REVIEW assigned to doctor); refunds table doesn't reflect it, so the breach-refund idempotency check (`WHERE order_id = $ AND reason = 'sla_breach'`) doesn't see it; reconciliation breaks. | **Fix scope:** medium | **Verification:** VERIFIED-code

### P1-STATE-14 — Auto-assign job races with broadcast-to-specialty and superadmin manual assign
**Severity:** P1 | **Category:** race | **Location:** `src/routes/payments.js:457-469`, `src/auto_assign.js:93-187`, `src/notify/broadcast.js:29` | **Description:** After payment confirm, the webhook fires both `enqueueAutoAssign(orderId)` and `broadcastOrderToSpecialty(orderId)` simultaneously, and the auto-assign reads `if (order.doctor_id) return already_assigned` — but a broadcasted doctor accepting at the same moment is a TOCTOU. The accept handler `routes/doctor.js:1942-1957` checks `(doctor_id IS NULL OR doctor_id = '' OR doctor_id = $5)` — so two doctors clicking accept simultaneously: first wins, second silent redirect. But auto-assign that finishes second can over-write the broadcast acceptor's doctor_id since `auto_assign.js:157-160` does an unconditional UPDATE without `WHERE doctor_id IS NULL`. | **Impact:** Doctor who legitimately accepted via broadcast can be silently replaced by auto-assign worker if the worker completes after acceptance. | **Fix scope:** small (add `WHERE doctor_id IS NULL` guard to auto_assign UPDATE) | **Verification:** VERIFIED-code

### P1-STATE-15 — `markOrderCompletedFallback` uses raw UPDATE — bypasses canonical `transitionCase(IN_REVIEW → COMPLETED)`
**Severity:** P1 | **Category:** state | **Location:** `src/routes/doctor.js:4098-4174` | **Description:** Doctor report-generate path calls `markOrderCompletedFallback` which does a raw `UPDATE orders SET status='COMPLETED'`. No `transitionCase`, no `case_events:status:COMPLETED`, no payment-gate (which would be no-op since paid by now), no `closeOpenDoctorAssignments` (so the assignment row's `completed_at` is NEVER closed when the case completes — only when status flips to IN_REVIEW). | **Impact:** `doctor_assignments.completed_at` stays NULL on completed cases. Capacity counts in `case_sla_worker.fetchDoctorTimeouts` / `pickNextAvailableDoctor` over-count active load — doctors stay capacity-blocked even after completing. | **Fix scope:** small | **Verification:** VERIFIED-code

### P2-STATE-16 — Superadmin extend-sla un-breach uses raw UPDATE and writes non-canonical `'submitted'`/`'assigned'`
**Severity:** P2 | **Category:** state | **Location:** `src/routes/superadmin.js:2780-2783` | **Description:** When extending SLA on a breached order, status flips back to `'assigned'` or `'submitted'` (lowercase). No update to `breached_at` (still set). No `case_events`. No removal of breach-time refund row from `refunds` table — patient already got refunded the uplift, but case is now active again. | **Impact:** Inconsistent state: case is active with a refund-row recorded; orphaned breach refund. Status casing drift. | **Fix scope:** small | **Verification:** VERIFIED-code

### P2-STATE-17 — `markCasePaid` `payment_due_at` window check blocks repaid late orders
**Severity:** P2 | **Category:** payment | **Location:** `src/case_lifecycle.js:5-29` (`assertPaidGate`) | **Description:** `assertPaidGate` blocks any transition (including → PAID) when `payment_due_at < now AND !paid_at`. But the unpaid sweep at `case_lifecycle.js:521-587` flips status to `expired_unpaid` past 24h. After that, if a webhook arrives late from Paymob (delayed network, retry), `markCasePaid` will be silently no-op'd by the payment-gate (logged as `[payment-gate] Payment window expired`). Money taken, no order. | **Impact:** Real risk in production — Paymob retries up to 3 days. Webhook arriving 25h after intent creation gets blocked by payment_due_at expiry. | **Fix scope:** medium | **Verification:** VERIFIED-code

### P2-STATE-18 — `payment_status` and `status` can drift: webhook sets payment_status=paid OUTSIDE the markCasePaid transaction
**Severity:** P2 | **Category:** payment/race | **Location:** `src/routes/payments.js:357-369` then `:404` | **Description:** Webhook does `UPDATE orders SET payment_status='paid'` (line 357 atomic guard) THEN calls `markCasePaid` separately. If the second call throws (lost connection, app crash, race with mark-as-unpaid), the row sits with `payment_status=paid` but `status=SUBMITTED` and no `sla_hours`. The `assertPaidGate` will allow future transitions because `paid_at` is set, but `markCasePaid`'s sla_hours invariant could fail on retry — and there's no retry mechanism. | **Impact:** Orphan rows with payment confirmed but lifecycle never advanced; no auto-assign queued; patient sees "we're confirming your payment" forever. | **Fix scope:** medium (combine the two UPDATEs into the `markCasePaid` transaction) | **Verification:** VERIFIED-code

### P2-STATE-19 — Three SLA worker implementations co-exist (server.js cron, case_sla_worker.js, sla_watcher.js) with overlapping logic
**Severity:** P2 | **Category:** lifecycle/race | **Location:** `src/server.js:1020-1105` (`runSlaReminderJob`), `src/case_sla_worker.js`, `src/sla_watcher.js`, `src/routes/superadmin.js:538` (`performSlaCheck`) | **Description:** Four SLA sweep paths can run concurrently. Each takes a different status set: `server.js` excludes only completed/cancelled/canceled/rejected; `case_sla_worker` scans `in_review`+`rejected_files`; `sla_watcher` scans `new`/`accepted`/`in_review`. They all write `'breached'` (server, watcher, superadmin) or canonical `SLA_BREACH` (case_sla_worker). The `breached_at` IS NULL guard prevents true double-mark, but breach refund hooks fire from server.js + sla_status.js + case_lifecycle hook — only `issueBreachRefund`'s refunds-row idempotency saves us. | **Impact:** Defensive idempotency works but logic is fragile and maintenance is high; one missed `WHERE breached_at IS NULL` check in any path = double refund. | **Fix scope:** large | **Verification:** VERIFIED-code

### P2-STATE-20 — Status `'expired_unpaid'` is written but not in canonical CASE_STATUS or aliases
**Severity:** P2 | **Category:** state | **Location:** `src/case_lifecycle.js:525,549` | **Description:** Unpaid sweep writes `status='expired_unpaid'`. Not in `CASE_STATUS`, not in `STATUS_ALIASES`, not in `CASE_STATUS_UI`. `getStatusUi` returns the empty fallback for it. `isTerminalStatus('expired_unpaid')` returns false (the UI map has no entry). | **Impact:** Patient/doctor dashboards show the raw string. The case can technically still be picked up by some sweeps that exclude only canonical-terminal statuses. | **Fix scope:** small (add as canonical terminal status with UI text) | **Verification:** VERIFIED-code

### P2-STATE-21 — Canonical `transitionCase` `from === to` early-return swallows status updates with new data
**Severity:** P2 | **Category:** lifecycle | **Location:** `src/case_lifecycle.js:1194-1204` | **Description:** `assertTransition` returns silently when `from === to`. But if the caller passes `data` (e.g., `breached_at`, `accepted_at`) AND the status is the same, the early return DOES allow the update through. However it skips the `sla_hours` invariant check — re-asserting PAID with different sla_hours is permitted by sequence (line 1198 `if (from === to) return;` is in `assertTransition`, called at line 1238; but `transitionCase` continues afterward). Verified the status invariant runs even on same-status. OK, but: `from === to` skips the check `STATUS_TRANSITIONS[from]?.includes(to)` — meaning transitions that aren't in the map (CANCELLED, COMPLETED) self-transition silently. | **Impact:** Minor; `if (from === to) return` in assertTransition lets COMPLETED→COMPLETED self-update happen. Probably intended for idempotency. | **Fix scope:** small | **Verification:** VERIFIED-code

### P2-STATE-22 — `STATUS_TRANSITIONS` has no entry for COMPLETED; canonical re-open from COMPLETED is impossible
**Severity:** P2 | **Category:** lifecycle | **Location:** `src/case_lifecycle.js:709-723` | **Description:** Map defines transitions FROM DRAFT/SUBMITTED/PAID/ASSIGNED/IN_REVIEW/REJECTED_FILES/SLA_BREACH/REASSIGNED/CANCELLED. There is no key for `COMPLETED`, meaning `assertTransition` will throw `No transitions defined from COMPLETED` if any code calls `transitionCase(id, X)` on a completed case. The "edits unlock by admin" feature mentioned in `CASE_STATUS_UI[COMPLETED].doctor.description` has no corresponding canonical reverse-transition. | **Impact:** No way to re-open a completed case via the canonical path. Any admin "unlock" feature would have to use raw UPDATE — and it does not exist anywhere yet. | **Fix scope:** small (add `COMPLETED: [IN_REVIEW]` if unlock is intended) | **Verification:** VERIFIED-code

### P2-STATE-23 — `assignDoctor` allows assignment from REASSIGNED but not from raw `'breached'` cases
**Severity:** P2 | **Category:** state | **Location:** `src/case_lifecycle.js:1783-1789` | **Description:** Guard: `if (![PAID, REASSIGNED].includes(currentStatus)) throw`. After server.js writes `status='breached'` (non-canonical SLA_BREACH), normalize maps it → `SLA_BREACH`, so `currentStatus !== REASSIGNED`. The auto-reassign in `markSlaBreach` calls `reassignCase` which transitions to REASSIGNED first then calls `assignDoctor` — that works. But the manual superadmin reassign-from-breach calls raw UPDATE so this guard never triggers. Inconsistent. | **Impact:** Mixed paths — canonical works, raw paths skip. | **Fix scope:** small | **Verification:** VERIFIED-code

### P2-STATE-24 — Stub payment-success path duplicates the webhook's UPDATE outside the markCasePaid transaction
**Severity:** P2 | **Category:** payment | **Location:** `src/routes/patient.js:1791-1828` | **Description:** Stub mode (non-live) calls `markCasePaid(orderId)` then runs an additional `UPDATE orders SET payment_status='paid', paid_at=COALESCE(paid_at,$1), draft_step=5, payment_method='stub'`. This is outside the `markCasePaid` transaction. If `markCasePaid` succeeds and the subsequent UPDATE fails, payment_status doesn't reflect paid (relies on COALESCE so paid_at is set inside markCasePaid via lifecycle? — no, lifecycle just sets `paid_at` on the orders row only IF payment_status column doesn't exist; with the column, the route is the only writer). | **Impact:** Stub-only (test path). But pattern duplicates P2-STATE-18 risk in test mode. | **Fix scope:** small | **Verification:** VERIFIED-code

### P3-STATE-25 — `pickNextAvailableDoctor` filters by `LOWER(status) IN ('assigned','in_review','rejected_files','sla_breach')` — misses `'awaiting_files'` and `'breached'`
**Severity:** P3 | **Category:** lifecycle | **Location:** `src/case_lifecycle.js:1733-1745` | **Description:** Capacity check uses a hardcoded status list that does NOT include the non-canonical states `awaiting_files` and `breached` that other paths write. Doctors with cases stuck in those states show 0 active load and can be picked up to capacity 4 by SLA-breach auto-reassign. | **Impact:** Doctors get over-assigned in practice. | **Fix scope:** small | **Verification:** VERIFIED-code

---

## Summary of canonical-vs-raw drift

The single biggest theme across these findings: the codebase has a clean canonical lifecycle (`case_lifecycle.js` with `transitionCase`, `assertCanonicalDbStatus`, status enum), AND a parallel set of legacy raw-SQL paths that bypass it (`routes/doctor.js` accept/reject/complete, `routes/superadmin.js` mark-paid/reassign/cancel/extend-sla/approve-files, `server.js runSlaReminderJob`, `sla_watcher.js`, `sla_status.js`). The canonical path enforces invariants (sla_hours on PAID, accepted_at on IN_REVIEW, payment-gate, doctor_assignments closure, partial-pay on reassign, refund hooks). The legacy paths skip them silently. Fixing this is the single highest-leverage launch-blocker work in the state machine.


---

# Section 05 — External integrations audit

# External Integrations Audit — 2026-05-06

Scope: every external service reached over the network. Every finding is rooted in `VERIFIED-code`
unless otherwise marked. Severity follows the brief's rules (P0 = launch-day failure).

---

## 0. Per-integration summary table

| # | integration | configured? | tokens-expire? | alerts-on-failure? | fallback? |
|---|---|---|---|---|---|
| 1 | Paymob (cards) | partial: PAYMOB_LIVE_PAYMENTS missing from `.env.example`; `PAYMOB_MODE=test` hard-gates `services/paymob.js` so live payments are **impossible to ship** without code edit | secret-key static; HMAC secret static (rotation only via dashboard) | yes for HMAC failure (sendCriticalAlert) — but alert path itself broken (see INT-7) | none — payment dead = order dead |
| 2 | Uploadcare | UPLOADCARE_PUBLIC_KEY in env; UPLOADCARE_SECRET_KEY documented but **never read** in code; verify.js has 3-way alias (PUBLIC_KEY → PUBLIC → KEY) | static keys | no | none — uploads dead = wizard dead |
| 3 | Twilio Verify (OTP) | TWILIO_VERIFY_SERVICE_SID + ACCOUNT_SID + AUTH_TOKEN | static | no — silent stub on missing creds; OTP visible in `otp_codes` table | DB-stored OTP fallback (still leaks OTP in cleartext) |
| 4 | Twilio Video | API_KEY/API_SECRET fall back to ACCOUNT_SID/AUTH_TOKEN if absent | token TTL 3600s; API key static | no | none — video token endpoint returns 503; booking pages render anyway |
| 5 | WhatsApp Cloud API (Meta) | WHATSAPP_ENABLED=true required; PHONE_NUMBER_ID + ACCESS_TOKEN | **token expires** (~60d for system-user, never refreshed in code) | token-expiry path logs to error_logs but no alert fires | none — silent skip; OTP falls back to Twilio Verify |
| 6 | Resend / SMTP (email) | **`RESEND_API_KEY` is the actual env var; `.env.example` documents only obsolete SMTP_*  vars** | static API key | no | none |
| 7 | Anthropic (Claude) | required at boot; server exits if missing | static API key; **model `claude-sonnet-4-20250514` and `claude-haiku-4-5` are stale** | no — case-intelligence marks order failed silently | none |
| 8 | ElevenLabs | not present in codebase | n/a | n/a | n/a |
| 9 | Cloudinary | CLOUDINARY_CLOUD_NAME + API_KEY + API_SECRET | static | no | none — IG image generation dead |
| 10 | Instagram / Meta Graph | META_APP_ID + META_APP_SECRET + IG_ACCESS_TOKEN + IG_BUSINESS_ACCOUNT_ID + FB_PAGE_ID | **token expires (~60d); refresh code exists but is never called and never persists the new value** | no — failed posts written to DB row only | none |
| 11 | Tailscale (ops SSH) | OPS_SSH_HOST/USER/KEY_PATH | n/a | no | n/a — non-critical observability |
| 12 | R2 / Cloudflare storage | R2_ENDPOINT + R2_ACCESS_KEY_ID + R2_SECRET_ACCESS_KEY + R2_BUCKET_NAME — **all 4 missing from `.env.example`** | static | warn-only on boot HEAD failure; no runtime alerts | none — file downloads return 500 |
| 13 | Supabase (Postgres) | DATABASE_URL via pgbouncer (PG_POOL_MAX=10 sized for Supabase free tier) | n/a | logs `pool error`, no alert | n/a |
| 14 | Render | RENDER_GIT_COMMIT + RENDER_SERVICE_NAME (auto-injected) | n/a | health endpoints `/health`, `/healthz`, `/__version` exist; no `render.yaml`/`Procfile` checked into repo so health-check binding is unverified | n/a |
| — | OpenAI (DALL-E) | OPENAI_API_KEY (used by IG image generator) | static | inline 503 from /admin IG routes only | none |

---

## 1. Paymob

### P0-INT-1 — `services/paymob.js` is hard-gated to test mode; live payments cannot ship
**Severity:** P0  
**Category:** payment  
**Location:** `src/services/paymob.js:39-46` (`_assertTestMode`)  
**Description:** `_assertTestMode()` throws `PAYMOB_MODE_NOT_TEST` if `PAYMOB_MODE !== 'test'`. The header comment explicitly states "Switching to live requires editing this file intentionally." Every public entry asserts test mode. There is no live-mode code path.  
**Impact:** the moment the team flips `PAYMOB_MODE=live` in Render, every patient checkout throws 502 `paymob_unavailable`. The launch-blocking question "what happens when set to 'live'?" answers: hard-coded refusal.  
**Fix scope:** small (remove gate, add a real risk check) or medium (allow `PAYMOB_MODE=live` but require an additional `PAYMOB_LIVE_CONFIRM=YES_I_UNDERSTAND` token).  
**Verification:** VERIFIED-code

### P0-INT-2 — `PAYMOB_LIVE_PAYMENTS` env var read by patient.js but undocumented; mismatched naming with `PAYMOB_MODE`
**Severity:** P0  
**Category:** payment  
**Location:** `src/routes/patient.js:1332,1690,1773`  
**Description:** Three call sites read `process.env.PAYMOB_LIVE_PAYMENTS`. This env var is **not in `.env.example`**, **not in `services/paymob.js`** (which uses `PAYMOB_MODE`), and **the code that branches on it does not enforce** the `PAYMOB_MODE=test` gate. So:
- if ops sets `PAYMOB_LIVE_PAYMENTS=true` and forgets `PAYMOB_MODE=live`, step5 redirects to the real Paymob hosted form, which then calls `paymobService.createIntention`, which throws `PAYMOB_MODE_NOT_TEST` → 502.  
- if ops sets `PAYMOB_LIVE_PAYMENTS=false`, the wizard bounces patients to a `?stub=1` success route that calls `markCasePaid()` server-side **with no payment actually taken**. This is a launch-day landmine: a misconfigured Render env at go-live will mark every order PAID with no money received.

**Impact:** payment fraud potential or 502 storm on launch day. Two env vars governing the same decision is the bug class that bit Uploadcare.  
**Fix scope:** medium — collapse into one `PAYMOB_MODE` source of truth, document clearly, add bootCheck assertion.  
**Verification:** VERIFIED-code

### P1-INT-3 — Paymob intention is **not reused on retry**; migration 042 created `paymob_intentions` table that no code reads
**Severity:** P1  
**Category:** payment  
**Location:** `src/migrations/042_paymob_intentions.sql`; nothing in `src/routes/payments.js` or `src/services/paymob.js` references the table  
**Description:** Migration 042 was advertised as caching Paymob intentions to avoid burning a fresh client_secret per page load. Code stores `paymob_intention_id` on `orders` (line 162 of payments.js) but **never checks it before calling `createIntention`**. There is no `paymob_intentions` table read anywhere. Each "Pay Now" click makes a fresh intention.  
**Impact:** under traffic, Paymob has documented per-merchant rate limits on the intention API; refresh bursts will 429. Per-order audit trail is fragmented across many intention IDs.  
**Fix scope:** small — add a `SELECT paymob_intention_id FROM orders WHERE id=...` guard before creating, validate the cached intention is still alive, otherwise create a new one.  
**Verification:** VERIFIED-code

### P1-INT-4 — Paymob webhook idempotency depends on `obj.id` being present; defensive-fallback path silently bypasses idempotency
**Severity:** P1  
**Category:** payment  
**Location:** `src/routes/payments.js:264-296`  
**Description:** "(If paymobTxnId is missing — defensive fallback — we skip the per-txn idempotency check and rely on the per-order UPDATE guard below. Paymob's documented payload always includes obj.id.)" If Paymob ever delivers a webhook without `obj.id` (or with a malformed payload that strips it during HMAC verification's pre-parse), idempotency degrades to per-order — but for cancelled/failed txns the per-order guard never fires (it only locks the row when status=paid), so the same `payment_failed` notification could fire twice on a Paymob retry storm.  
**Impact:** patient gets two "payment failed" emails. Recoverable.  
**Fix scope:** small — synthesize a fallback dedupe key from (orderId, status, received_at::date).  
**Verification:** VERIFIED-code

### P2-INT-5 — Webhook handler trusts `req.ip` for HMAC failure alert without IP allowlist
**Severity:** P2  
**Category:** payment  
**Location:** `src/routes/payments.js:230-234`  
**Description:** `sendCriticalAlert` is throttled to 1/5min so flooding can't spam admin, but Paymob has documented webhook source IPs the handler doesn't allowlist. Combined with INT-7 (sendCriticalAlert is partly broken), the operational alerting on payment-callback abuse is weaker than the comment suggests.  
**Fix scope:** medium — add Paymob IP allowlist + drop the alert path since it's noisy and broken.  
**Verification:** VERIFIED-code

---

## 2. Uploadcare

### P1-INT-6 — `UPLOADCARE_SECRET_KEY` documented in `.env.example` but **never read by any code**
**Severity:** P1  
**Category:** storage  
**Location:** `.env.example:88`; no reads anywhere in `src/`  
**Description:** Grep for `process.env.UPLOADCARE_SECRET` returns zero hits across `src/` and `scripts/`. The key is documented as required but no upload-completion webhook, signed-uploads, or REST API call exists. Mobile uploads are widget-side only.  
**Impact:** false sense of security for ops — they will set the secret thinking it's wired, but the production code does not authenticate any Uploadcare calls. If the launch plan involves enabling signed uploads (recommended for HIPAA-adjacent workloads), it requires net-new code.  
**Fix scope:** small (delete the env line) or medium (wire signed uploads).  
**Verification:** VERIFIED-code

### P2-INT-7 — `verify.js` uses three-way alias `UPLOADCARE_PUBLIC_KEY || UPLOADCARE_PUBLIC || UPLOADCARE_KEY` — exactly the bug class the brief flagged
**Severity:** P2  
**Category:** storage  
**Location:** `src/routes/verify.js:100-104`  
**Description:** The diagnostic endpoint OR-chains three env-var names. Every actual upload code path uses `UPLOADCARE_PUBLIC_KEY` only. If an ops engineer drops the legacy alias in Render, the diagnostic still reads green while the wizard is broken. This is the same drift pattern that caused the production Uploadcare outage.  
**Fix scope:** small — drop the OR-chain in verify.js; canonicalize on `UPLOADCARE_PUBLIC_KEY`.  
**Verification:** VERIFIED-code

### P3-INT-8 — Uploadcare widget loaded from CDN without SRI hash
**Severity:** P3  
**Category:** storage  
**Location:** `src/views/patient_new_case.ejs:890`, `patient_order.ejs:561`, `patient_order_upload.ejs:83`  
**Description:** `<script src="https://ucarecdn.com/libs/widget/3.x/uploadcare.full.min.js">` — no `integrity=` attribute. CDN compromise = full upload-flow XSS.  
**Fix scope:** small.  
**Verification:** VERIFIED-code

---

## 3. Twilio Verify (OTP for mobile login)

### P1-INT-9 — OTPs are generated AND stored in `otp_codes` even when Twilio Verify is configured; cleartext leak in DB
**Severity:** P1  
**Category:** auth  
**Location:** `src/routes/api/auth.js:170-178` and `:228-236`  
**Description:** Every OTP request runs `randomInt(100000, 1000000)` and INSERTs the code into `otp_codes` *before* calling Twilio. The verify endpoint **first** checks Twilio Verify, then falls back to the local `otp_codes` table. So even with Twilio Verify wired up:
- the locally-generated 6-digit code is in plaintext in the DB for 10 minutes
- if Twilio Verify denies the code but the local-table code matches (because Twilio generated a *different* code from the one we stored), the patient gets in via the dev fallback

This means the fallback path effectively defeats Twilio Verify's tamper-resistance.  
**Impact:** an attacker with read-only DB access during the 10-min TTL can log in as any phone-validated user.  
**Fix scope:** small — when Twilio Verify is configured, skip the local INSERT entirely (and skip the fallback SELECT).  
**Verification:** VERIFIED-code

### P2-INT-10 — `sendOtpViaTwilio` discards the message arg; legacy callers passing custom messaging silently get the default
**Severity:** P2  
**Category:** auth  
**Location:** `src/services/twilio_verify.js:42-66`  
**Description:** Function signature `(phone, message)` but the message is logged-only and discarded. The brief noted this — Twilio Verify generates its own copy ("Your <service> verification code is: XXXXXX"). Confusing API for callers; potential confusion if marketing wants to customize.  
**Fix scope:** small — drop the message param, update call sites.  
**Verification:** VERIFIED-code

### P2-INT-11 — Twilio Verify has no rate-limiting on our side; abuser can drain Twilio Verify quota / cost
**Severity:** P2  
**Category:** auth  
**Location:** `src/routes/api/auth.js:160` (`/otp/request`)  
**Description:** No `express-rate-limit` on this endpoint. Each request triggers a paid Twilio Verify SMS (or an inserted DB row in stub mode). One bad actor could exhaust the day's Twilio quota in minutes.  
**Fix scope:** small — add a per-IP/per-phone rate limiter (e.g., 3/15min).  
**Verification:** VERIFIED-code

---

## 4. Twilio Video

### P0-INT-12 — Patient can book + pay for a video appointment when `VIDEO_CONSULTATION_ENABLED=false`; only token endpoint blocks them
**Severity:** P0  
**Category:** payment  
**Location:** `src/routes/video.js:92-227`, `:719-721`  
**Description:** The booking GET (`/portal/video/book/:orderId`), POST (`/portal/video/book`), payment redirect, and Paymob webhook (`/portal/video/payment/callback`) all run **regardless of `isVideoEnabled()`**. Only `/api/video/token/:appointmentId` returns 503 when disabled. So the patient pays for a video consult, the row goes to `confirmed`, doctor accepts, and at appointment time **the join button silently fails** with no refund path.  
**Impact:** real money taken with no service deliverable; manual refund needed; reputational damage.  
**Fix scope:** medium — gate `/portal/video/book` GET + POST on `isVideoEnabled()` with a clear "Video consults temporarily unavailable" error.  
**Verification:** VERIFIED-code

### P1-INT-13 — Twilio API key/secret silently fall back to ACCOUNT_SID/AUTH_TOKEN if absent — token generation will work but is non-rotatable
**Severity:** P1  
**Category:** auth  
**Location:** `src/video_helpers.js:14-17`  
**Description:** Comment claims this is "valid for development"; code does not gate by NODE_ENV, so production with missing TWILIO_API_KEY silently uses the master AUTH_TOKEN to mint video access tokens. AUTH_TOKEN is the credential for the entire account — leaking it via a JWT token in browser is much higher blast radius than a scoped API key.  
**Impact:** if Twilio pulls the JWT for inspection (they do, on connect failures), AUTH_TOKEN becomes derivable.  
**Fix scope:** small — when MODE=production and TWILIO_API_KEY is missing, throw at boot.  
**Verification:** VERIFIED-code

### P1-INT-14 — Twilio Video TTL is 3600s; long appointments will see token expire mid-call with no refresh
**Severity:** P1  
**Category:** other  
**Location:** `src/video_helpers.js:50-53`  
**Description:** Token `ttl: 3600` (1h). If a call runs over 60 minutes, browsers receive a `TwilioError: Access Token expired` and disconnect with no client-side refresh code in `/js/video-consultation.js` (per the route, it only fetches the token once on init).  
**Fix scope:** medium — add a refresh-token endpoint and a client-side refresh timer at T-5min.  
**Verification:** VERIFIED-code

### P2-INT-15 — CSP `connect-src` blocks Twilio Video signaling
**Severity:** P2  
**Category:** other  
**Location:** `src/server.js:246`  
**Description:** `connect-src 'self' https://upload.uploadcare.com https://api.uploadcare.com https://ucarecdn.com` — no `wss://*.twilio.com` / `https://*.twilio.com` / `https://media.twiliocdn.com`. Twilio Video signaling will be blocked by CSP. This will surface as "Unable to acquire configuration" or media negotiation errors in the browser console — not as a server error.  
**Fix scope:** small — extend connect-src for Twilio domains; verify against the Twilio Video CSP guide (https://www.twilio.com/docs/video/javascript/twilio-video-csp).  
**Verification:** VERIFIED-code

---

## 5. WhatsApp Cloud API (Meta)

### P0-INT-16 — `critical-alert.js` reads env vars at module-load and uses `type: 'text'` free-form messages — broken outside the 24-hour customer-service window
**Severity:** P0  
**Category:** messaging  
**Location:** `src/critical-alert.js:6-9, 30-35`  
**Description:** Two compounding problems:
1. `ADMIN_PHONE`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_API_VERSION` are captured into module-level `var`s at first require. If ops rotates the access token in Render and restarts only this process, these stale values stay until full restart — and the silent-401 failure mode the brief flagged is not detected.
2. The body is `{ type: 'text', text: { body: ... } }` — Meta only accepts free-form text from a business when the customer messaged the business in the past 24 hours. ADMIN_PHONE has not messaged the Tashkheesa WA business number recently → Meta returns 470/131047 ("re-engagement window expired") → critical alerts silently drop.

**Impact:** the alerting infrastructure for unhandled rejections, uncaught exceptions, and HMAC webhook failures **does not deliver** to the on-call admin under the most common operational state. This is the same class as the original token-expired-silently bug — except worse, because the alert path itself is the fallback.  
**Fix scope:** medium — switch to a Meta-approved utility-category template (one body param: the alert text), match the existing `sendWhatsApp` infrastructure, drop module-level env capture.  
**Verification:** VERIFIED-code

### P0-INT-17 — No token-expiry detection for WhatsApp Access Token; 401 on send is logged to error_logs but no alert path
**Severity:** P0  
**Category:** messaging  
**Location:** `src/notify/whatsapp.js:135-150`  
**Description:** When Meta returns 401 (token expired), the code logs to `error_logs` table with `status: 401` and returns `{ ok: false, error: data, status: 401 }`. **Nothing else fires**. No `sendCriticalAlert` (which would also be broken per INT-16), no SMS fallback, no degradation switch.  
This is precisely the bug from the recent foundational-bugs list. The fix landed `error_logs` entries, but there is still no alerting on the entry.  
**Impact:** WhatsApp OTP delivery, payment confirmations, SLA reminders all silently die for hours-to-days until a human notices.  
**Fix scope:** medium — add a periodic job that COUNT(*)s `error_logs WHERE category='whatsapp_send' AND status=401 AND created_at > NOW() - INTERVAL '15 min'` and pages on >0.  
**Verification:** VERIFIED-code

### P1-INT-18 — Object-iteration order assumption in `sendOtpViaWhatsApp` template var construction
**Severity:** P1  
**Category:** messaging  
**Location:** `src/services/whatsapp_otp.js:81` and `src/notify/whatsapp.js:109-115`  
**Description:** OTP route passes `vars: { otp_code: otpCode }`; sendWhatsApp does `Object.values(vars).map(v => ({ type: 'text', text: v }))`. With one key, fine. With two+ vars, ordering relies on JS object insertion order — works in V8 but brittle, and the Meta template requires positional args. Any future "send OTP with patient name as second var" change would silently swap parameters.  
**Fix scope:** small — accept arrays, not objects, for ordered template params.  
**Verification:** VERIFIED-code

### P1-INT-19 — `WHATSAPP_API_VERSION` defaults to `v22.0` — current Meta version as of cutoff is v25+, but defaults are unverified
**Severity:** P1  
**Category:** messaging  
**Location:** `src/notify/whatsapp.js:10`, `src/critical-alert.js:9`  
**Description:** Default `v22.0`. The validity of v22 is not the concern — the concern is that two modules (`whatsapp.js` and `critical-alert.js`) hardcode their own defaults. If ops sets `WHATSAPP_API_VERSION=v25.0` in Render, it propagates to one but the other module captures its env at module-load (see INT-16) — so they could be on different versions.  
**Fix scope:** small — single source of truth in a `config/whatsapp.js`.  
**Verification:** VERIFIED-code (drift confirmed in code; current API version not verified against Meta docs)

### P2-INT-20 — `ADMIN_PHONE` is read once at module-load; runtime rotation impossible
**Severity:** P2  
**Category:** messaging  
**Location:** `src/critical-alert.js:6`  
**Fix scope:** small — read inside the function.  
**Verification:** VERIFIED-code

### P2-INT-21 — There is no fallback transport for WhatsApp messages; when WhatsApp is dead, downstream receives `{ ok: false }` and gives up
**Severity:** P2  
**Category:** messaging  
**Location:** `src/notification_worker.js:244-256`  
**Description:** Worker re-tries with exponential backoff (30s/120s/480s) but never switches channel. Patients/doctors who were supposed to get a WhatsApp don't get a fallback SMS or email for the same notification — the row sits at `failed`.  
**Fix scope:** medium — on N consecutive `whatsapp_send` failures across users, automatically degrade `channels: ['whatsapp']` notifications to `channels: ['email']` and surface a banner to admins.  
**Verification:** VERIFIED-code

---

## 6. Resend / SMTP (email)

### P0-INT-22 — Code uses Resend; `.env.example` documents only legacy SMTP_*. `RESEND_API_KEY` is the real var and is missing from the docs.
**Severity:** P0  
**Category:** messaging  
**Location:** `src/services/emailService.js:40, 152-159`; `.env.example:90-99`  
**Description:** The transport was migrated to Resend on 2026-04-30 (per file header) but **`.env.example` still documents `SMTP_HOST=smtp.zoho.com`, `SMTP_PORT=465`, `SMTP_USER`, `SMTP_PASS`, `SMTP_SECURE`** — none of which the code reads (only `SMTP_FROM_EMAIL` and `SMTP_FROM_NAME` are read for the `from:` header). `RESEND_API_KEY` is the actual gate; if missing, `getTransporter()` calls `fatal()` and returns null and every email returns `{ok: false, error: 'email_not_configured'}` with no alert.  
**Impact:** an ops engineer reading `.env.example` will set the SMTP_* vars and see zero emails sent. Root-cause time: hours. Same class as the Uploadcare case-mismatch bug.  
**Fix scope:** small — fix `.env.example`. Add `RESEND_API_KEY=` line, drop the obsolete SMTP_HOST/PORT/USER/PASS/SECURE.  
**Verification:** VERIFIED-code

### P1-INT-23 — `EMAIL_ENABLED` default is `false`; lifecycle notifications bypass it (only the templated path is gated)
**Severity:** P1  
**Category:** messaging  
**Location:** `src/services/emailService.js:39, 369-372, 532-536`  
**Description:** Two paths exist:
- `sendEmail()` and `sendRawEmail()` check `EMAIL_ENABLED` → if false, returns `{ skipped: true }`.
- `sendMail()` (used by 6 lifecycle notifications: notifyCaseReceived, notifyCaseAssigned, notifyMoreInfoRequested, notifyCaseReassigned, notifyCaseCancelled, notifyDoctorFileUploaded) **deliberately does NOT check EMAIL_ENABLED**, only RESEND_API_KEY.

So `EMAIL_ENABLED=false` does not actually disable email — only the templated notification worker path. Killswitch is partial.  
**Fix scope:** small — collapse the two paths.  
**Verification:** VERIFIED-code

### P1-INT-24 — `EMAIL_GUARD_STRICT` defaults to `false`; MX-record validation off in production by design
**Severity:** P1  
**Category:** messaging  
**Location:** `src/services/recipientGuard.js:50-55`  
**Description:** Per the comment, MX validation is meant to flip on after 30 days of monitoring. Today (`MODE=production`), strict is off, so emails to typo'd domains (e.g., `gmail.con`) are sent and bounce. Resend will count them against sending reputation.  
**Fix scope:** small — flip default to true when `MODE=production`.  
**Verification:** VERIFIED-code

### P2-INT-25 — `recipientGuard.detectCaller()` returns Node-internal frames for async sends — telemetry gap
**Severity:** P2  
**Category:** messaging  
**Location:** `src/services/recipientGuard.js:122-140`  
**Description:** Already TODO'd in the file. `blocked_send_attempts.stack_caller` is mostly garbage like `node:internal/process/task_queues:103:5`.  
**Fix scope:** medium — capture the call-site stack inside `_guardedSendMail` synchronously and thread it through.  
**Verification:** VERIFIED-code

### P3-INT-26 — Resend `verify()` always returns true; health check is decorative
**Severity:** P3  
**Category:** messaging  
**Location:** `src/services/emailService.js:140-145, 472-488`  
**Description:** The Resend SDK has no SMTP-style handshake. `verifyConnection()` returns `{ ok: true }` whenever `RESEND_API_KEY` is set — even if it's invalid. Boot-time health checks won't catch a typo'd key.  
**Fix scope:** small — issue a real test send to a noreply seam, or call Resend's `domains.list` once at boot.  
**Verification:** VERIFIED-code

---

## 7. Anthropic API (Claude)

### P0-INT-27 — Hardcoded model `claude-sonnet-4-20250514` is **stale**; current Sonnet (per assistant cutoff Jan 2026) is 4.6+
**Severity:** P0  
**Category:** ai  
**Location:**
- `src/case-intelligence.js:244`
- `src/ai_image_check.js:39`
- `src/routes/ai_assistant.js:116`
- `src/routes/patient.js:917` (`claude-haiku-4-5`)

**Description:** Three different files hardcode `claude-sonnet-4-20250514` (May 2025 release), one hardcodes `claude-haiku-4-5`. Per CLAUDE.md guidance and the brief, model names rot. Anthropic does deprecate model IDs (see https://docs.claude.com/en/docs/about-claude/model-deprecations); stale IDs return 404 or fall back to a different model with different pricing/capabilities.  
**Impact:** at any point Anthropic could 404 these IDs, and the AI assistant + case intelligence + image check all break simultaneously, blocking the order intake flow (case-intelligence runs synchronously in some paths).  
**Fix scope:** small — read model from `process.env.ANTHROPIC_MODEL` with fallback to `claude-sonnet-4-5` or whatever the current canonical is at deploy time. Pull model alias once at deploy via release notes.  
**Verification:** VERIFIED-code

### P1-INT-28 — No prompt-cache used for catalog or system prompts despite stable + repeated content
**Severity:** P1  
**Category:** ai  
**Location:** `src/routes/ai_assistant.js:115-120`; `src/case-intelligence.js:243-251`  
**Description:** The /help-me-choose system prompt embeds a 5-min-cached service catalog (~2-5KB). The case-intelligence extractor system prompt is identical across all calls. Neither uses `cache_control: { type: 'ephemeral' }`. Per CLAUDE.md guidance + the Claude API skill trigger, prompt caching can save 90% on prefix tokens. With expected request volume + 200+ token system prompts, this is real money.  
**Fix scope:** small — add `cache_control` markers.  
**Verification:** VERIFIED-code

### P1-INT-29 — `case-intelligence.js` instantiates Anthropic client at module-load with possibly-undefined apiKey
**Severity:** P1  
**Category:** ai  
**Location:** `src/case-intelligence.js:17`  
**Description:** `var anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });` — runs once at require time. The boot-time guard in `server.js:52` catches missing key (server exits), but tests/scripts that require the module without env will get an SDK that throws on first `.create()`. Not launch-blocking because the boot guard exists, but fragile.  
**Fix scope:** small — lazy-init the client.  
**Verification:** VERIFIED-code

### P1-INT-30 — Case-intelligence retry logic gives up after 2 attempts and silently writes `processing_error`; no user-visible state
**Severity:** P1  
**Category:** ai  
**Location:** `src/case-intelligence.js:241-296, 509-515`  
**Description:** Two attempts with 5s delay. On final failure, sets `processing_error` on the file row and `intelligence_status='failed'` on the order. The doctor sees no banner, the patient sees no banner. The `processing_error` column is read by /ops but no other surface.  
**Impact:** doctor opens the case, sees garbage extraction or empty extraction, has no idea why.  
**Fix scope:** medium — surface `intelligence_status` on the doctor case detail view ("AI summary unavailable — viewing raw files").  
**Verification:** VERIFIED-code

### P2-INT-31 — Case-intelligence has no per-case token budget guard; one PDF could blow Anthropic spend
**Severity:** P2  
**Category:** ai  
**Location:** `src/case-intelligence.js:241-251`  
**Description:** `messages.create` is called with the full extracted PDF text. Files up to 20 MB are accepted (line 14). 20 MB of OCR'd text could be hundreds of thousands of tokens. No per-call token check, no per-day budget cap.  
**Fix scope:** medium.  
**Verification:** VERIFIED-code

### P2-INT-32 — `ai_image_check.js` uses the raw `https.request` API and `anthropic-version: 2023-06-01` — no SDK path
**Severity:** P2  
**Category:** ai  
**Location:** `src/ai_image_check.js:38-99`  
**Description:** Three different patterns to call Anthropic across the codebase: (a) `@anthropic-ai/sdk` in case-intelligence, (b) `@anthropic-ai/sdk` in ai_assistant, (c) raw `https.request` in ai_image_check, (d) raw `https.request` in `routes/patient.js:919`. The `2023-06-01` API version is the default (still valid) but the parallel implementations diverge on retries, telemetry, and prompt caching.  
**Fix scope:** medium — consolidate.  
**Verification:** VERIFIED-code

---

## 8. ElevenLabs

### N/A-INT-33 — No ElevenLabs / 11labs references found
**Severity:** —  
**Category:** —  
**Location:** absent  
**Description:** Grep for `elevenlabs|11labs|ELEVENLABS` returns zero hits across `src/`, `app.js`, `.env.example`, `scripts/`, `package.json`. Integration is not present.  
**Verification:** VERIFIED-code (negative result)

---

## 9. Cloudinary (Instagram image hosting)

### P2-INT-34 — Cloudinary fails open: missing creds → SDK initialized with `undefined` values, first upload throws
**Severity:** P2  
**Category:** storage  
**Location:** `src/instagram/image_generator.js:11-15`  
**Description:** `cloudinary.config({ cloud_name: undefined, ... })` does not throw at config time; first `uploader.upload()` throws an unauthenticated error which the IG routes (lines 164-196) DO check for via `OPENAI_API_KEY` presence — but Cloudinary creds are NOT checked. The 503 path only catches OpenAI, not Cloudinary.  
**Fix scope:** small.  
**Verification:** VERIFIED-code

---

## 10. Instagram / Meta Graph API

### P0-INT-35 — Long-lived token refresh exists but is **never scheduled and never persists** the new token
**Severity:** P0  
**Category:** other  
**Location:** `src/instagram/scheduler.js:121-128`; `src/instagram/client.js:49-62`  
**Description:** `scheduler.refreshToken()` exists but:
1. is not called from `start()` — there is no setInterval for it
2. when called manually (via `instagram/routes.js:44`), it updates `this.accessToken` in memory only; the new token is logged to console with no DB write, no Render API call, no env update
3. `IG_ACCESS_TOKEN` is read at config-module-load only (`src/instagram/config.js:11`) — even if scheduler refreshes, every other consumer (`InstagramPublisher`, `routes.js:13`) keeps the original

So the token will expire (Meta long-lived tokens are ~60 days), Instagram posting will silently 401, and the recovery path is broken in three independent ways.  
**Impact:** marketing automation goes down 60 days post-launch with no warning. Recovery requires manual token refresh, a code edit, or direct Render env update.  
**Fix scope:** large — schedule auto-refresh, persist via Render API or DB-stored override that other consumers read first.  
**Verification:** VERIFIED-code

### P1-INT-36 — Instagram scheduler `refreshToken()` never updates `igScheduler.publisher.client.accessToken`
**Severity:** P1  
**Category:** other  
**Location:** `src/instagram/scheduler.js:13-15, 122-127`  
**Description:** `this.client = new InstagramClient()` and `this.publisher = new InstagramPublisher()` (which has its own client). Refreshing `this.client.accessToken` doesn't propagate to `this.publisher.client.accessToken`. So even the in-memory refresh path is broken.  
**Fix scope:** small.  
**Verification:** VERIFIED-code

### P2-INT-37 — Instagram client throws ALL errors as `InstagramApiError` including network errors; calling code can't distinguish auth vs transient
**Severity:** P2  
**Category:** other  
**Location:** `src/instagram/client.js:38-45`  
**Fix scope:** small.  
**Verification:** VERIFIED-code

### P2-INT-38 — Rate-limit guard sleeps the request thread when within 5 of the cap; correlated calls all queue up
**Severity:** P2  
**Category:** other  
**Location:** `src/instagram/client.js:146-160`  
**Description:** When approaching the per-hour limit, every in-flight request sleeps for the remainder of the window (up to 1 hour). The Express request handler will hold the connection for 60 minutes, blowing past Render request timeouts.  
**Fix scope:** small — return a 429 instead of sleeping.  
**Verification:** VERIFIED-code

### P3-INT-39 — `pingOps()` in scheduler hits localhost:PORT — fails in multi-instance deployments
**Severity:** P3  
**Category:** other  
**Location:** `src/instagram/scheduler.js:131-140`  
**Verification:** VERIFIED-code

---

## 11. Tailscale (ops SSH)

### P1-INT-40 — `routes/ops.js` shells out via `exec` with **string-concatenated SSH command**; OPS_SSH_HOST/USER are env-controlled but unsanitized
**Severity:** P1  
**Category:** other  
**Location:** `src/routes/ops.js:29-40`  
**Description:** `var sshCmd = 'ssh -o ... ' + user + '@' + host + ' "' + cmd.replace(/"/g, '\\"') + '"';` — only `"` is escaped. `$()`, backticks, semicolons, and spaces inside `host` would inject. Mitigated by env-only inputs (not user-controlled), but a misconfigured env line breaks horribly.  
**Fix scope:** small — switch to `child_process.execFile(['ssh', '-i', keyPath, user + '@' + host, cmd])`.  
**Verification:** VERIFIED-code

### P2-INT-41 — `setInterval(refreshMacMiniStatus, 2*60*1000)` runs at module-load; failed SSH every 2 minutes if disabled
**Severity:** P2  
**Category:** other  
**Location:** `src/routes/ops.js:51-52`  
**Description:** Module-load side effect. Even if OPS_SSH_HOST isn't set, the interval fires; the function returns early via the `if (!host || !user)` guard but the timer keeps firing forever. In dev or staging, this is wasted timer slots. In production with a misconfigured key, exec spawns 720 ssh processes/day per instance.  
**Fix scope:** small.  
**Verification:** VERIFIED-code

---

## 12. R2 / Cloudflare storage

### P0-INT-42 — `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME` are all required at runtime but **none are in `.env.example`**
**Severity:** P0  
**Category:** storage  
**Location:** `src/storage.js:16, 23-32`; `.env.example` (absent)  
**Description:** `storage.js` warns on missing vars but does not throw — the SDK is initialized with `accessKeyId: undefined` and the first signed-URL call throws inside the doctor file-download flow (`src/server.js:404-411` returns 500 "File temporarily unavailable"). The `.env.example` does not mention R2 at all. Same pattern as the Uploadcare drift bug (and as INT-22).  
**Impact:** every doctor opening any case attachment that was uploaded post-R2-migration sees "File temporarily unavailable" with no recovery hint. Patient prescriptions, intake forms, lab results — all unreadable.  
**Fix scope:** small — add the four vars to `.env.example`. Add a bootCheck refusal in production.  
**Verification:** VERIFIED-code

### P1-INT-43 — Signed URL TTL hardcoded 3600s; long doctor reading sessions will time out
**Severity:** P1  
**Category:** storage  
**Location:** `src/storage.js:69`; `src/server.js:407`  
**Description:** Default 1h. Patient detail pages with `<img src=signedUrl>` will break after the doctor stays on the page for an hour. No client-side refresh.  
**Fix scope:** small — return short-lived URLs but add a `/files/:id?refresh=1` server route the client can hit on stale-URL detection.  
**Verification:** VERIFIED-code

### P2-INT-44 — R2 bucket HEAD check on boot fires even if storage isn't used by this instance type
**Severity:** P2  
**Category:** storage  
**Location:** `src/storage.js:90-94`  
**Verification:** VERIFIED-code

---

## 13. Supabase

### P1-INT-45 — `pg.js` pool is sized for Supabase Free tier (max=10); no comment for what to bump to on tier change
**Severity:** P1  
**Category:** other  
**Location:** `src/pg.js:25-48`  
**Description:** Comment says: "running a single Render instance with max=10 leaves headroom" — assumes the pgbouncer cap is 15 (Supabase free). At launch, if the project upgrades to Pro (cap 60), nothing in code changes; the override is `PG_POOL_MAX` env. **`PG_POOL_MAX` is not in `.env.example`.**  
**Fix scope:** small.  
**Verification:** VERIFIED-code

### P2-INT-46 — `ssl: process.env.PG_SSL === 'false' ? false : { rejectUnauthorized: false }` — TLS cert never validated
**Severity:** P2  
**Category:** auth  
**Location:** `src/pg.js:44`; `src/job_queue.js:22`  
**Description:** When PG_SSL is not 'false' (i.e., production), the SSL config is `{ rejectUnauthorized: false }` — accepts any certificate, including a MITM. Supabase's TLS chain is publicly issued; should be validated.  
**Fix scope:** small.  
**Verification:** VERIFIED-code

### P3-INT-47 — No Supabase-specific endpoints (auth.users, storage.objects) used — pure Postgres consumer
**Severity:** P3  
**Category:** —  
**Verification:** VERIFIED-code (negative)

---

## 14. Render

### P1-INT-48 — No `render.yaml` or `Procfile` checked into the repo; deploy config lives only in the Render dashboard
**Severity:** P1  
**Category:** other  
**Location:** repo root (absent)  
**Description:** Confirmed via `ls`. Health-check path, instance type, autoscaling rules, env-var bindings — none version-controlled. Disaster recovery (e.g., recreating the service in a fresh Render account) requires manual reconstruction from memory.  
**Fix scope:** medium — commit a `render.yaml` with healthCheckPath: `/healthz`.  
**Verification:** VERIFIED-code

### P2-INT-49 — `BASIC_AUTH_USER || STAGING_USER` aliasing in `server.js:78-79` reads two env names; `STAGING_USER`/`STAGING_PASS` not in `.env.example`
**Severity:** P2  
**Category:** auth  
**Location:** `src/server.js:78-79`  
**Description:** Exactly the alias-drift pattern the brief flagged. `BASIC_AUTH_USER` is documented; `STAGING_USER` is the silent fallback. Risk: ops sets the wrong name, basic auth opens silently because the OR-chain finds nothing → empty creds → handler decides what to do.  
**Fix scope:** small — drop the OR fallback; canonical name only.  
**Verification:** VERIFIED-code

### P2-INT-50 — `/healthz` returns 200 even when DB pool is exhausted; check is too shallow for Render to detect a half-dead service
**Severity:** P2  
**Category:** other  
**Location:** `src/routes/health.js:24-37`  
**Description:** Reads `pool.totalCount`, `pool.idleCount`, `pool.waitingCount` and returns them in the body but always with `ok: true`. Render only knows about HTTP status. A pool with 0 idle and 50 waiting is reported as healthy.  
**Fix scope:** small — return 503 if `waitingCount > N`.  
**Verification:** VERIFIED-code

---

## 15. Cross-cutting

### P0-INT-51 — Many integrations are documented in `.env.example` but the secret-key half is silently missing for the operative ones
**Severity:** P0  
**Category:** other  
**Location:** `.env.example` (multiple)  
**Description:** Summary of the documentation drift bugs found:
| env var | in .env.example? | actually read by code? |
|---|---|---|
| `RESEND_API_KEY` | ❌ | ✅ (gates all email) |
| `R2_ENDPOINT` | ❌ | ✅ (gates all signed-URL downloads) |
| `R2_ACCESS_KEY_ID` | ❌ | ✅ |
| `R2_SECRET_ACCESS_KEY` | ❌ | ✅ |
| `R2_BUCKET_NAME` | ❌ | ✅ |
| `PAYMOB_LIVE_PAYMENTS` | ❌ | ✅ (controls real-money branch) |
| `PG_POOL_MAX` | ❌ | ✅ (silently capped at 10) |
| `PG_POOL_CONNECT_TIMEOUT_MS` | ❌ | ✅ |
| `PG_POOL_IDLE_TIMEOUT_MS` | ❌ | ✅ |
| `STAGING_USER` | ❌ | ✅ (alias for BASIC_AUTH_USER) |
| `STAGING_PASS` | ❌ | ✅ |
| `WHATSAPP_TEST_STUB` | ❌ | ✅ (tests + fallback) |
| `EMAIL_TEST_STUB` | ❌ | ✅ |
| `ADDON_SYSTEM_V2` | ❌ | ✅ (gates dual-write) |
| `AGENT_NAME` / `SKILL_NAME` | ❌ | ✅ (recipient-guard audit) |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_SECURE` | ✅ | ❌ (pure noise; legacy) |
| `UPLOADCARE_SECRET_KEY` | ✅ | ❌ (no signed-uploads code) |

**Impact:** every undocumented env that's actually read is a launch-day landmine. Every documented env that isn't read teaches ops the wrong mental model.  
**Fix scope:** medium — pass through all `process.env.X` reads in `src/**/*.js` and reconcile against `.env.example` once. Add a CI check that diffs the two.  
**Verification:** VERIFIED-code

### P1-INT-52 — Module-load env capture is widespread; rotating any secret requires a full-process restart
**Severity:** P1  
**Category:** other  
**Locations:**
- `src/critical-alert.js:6-9` (ADMIN_PHONE, WHATSAPP_*)
- `src/services/emailService.js:39-40, 86-88` (RESEND_API_KEY, EMAIL_ENABLED, SMTP_FROM_EMAIL, APP_URL)
- `src/services/whatsapp_otp.js:32-33` (WHATSAPP_OTP_TEMPLATE_NAME, _LANG)
- `src/notify/whatsapp.js:5-11` (all WhatsApp envs, destructured at module-load)
- `src/notify.js:8-9` (WHATSAPP_ENABLED, EMAIL_ENABLED)
- `src/storage.js:16-32` (all R2)
- `src/instagram/config.js:1-35` (all Meta + Cloudinary keys)
- `src/video_helpers.js:8-12` (all Twilio)
- `src/ai_image_check.js:8` (ANTHROPIC_API_KEY)
- `src/case-intelligence.js:17` (Anthropic client init)

**Description:** Express servers running on Render reload env on full restart only. The `notify/whatsapp.js` pattern of destructuring at module load is particularly fragile: if Render hot-reloads env without a process restart, the code will continue to use stale values forever. Coupled with INT-17 (no token-expiry alerting), token rotation is operationally dangerous.  
**Fix scope:** medium — read `process.env.X` inside the function for security-sensitive keys (tokens, API keys), keep at module-load only for boot-time switches.  
**Verification:** VERIFIED-code

### P1-INT-53 — `services/emailService.js` exports `EMAIL_ENABLED` as a captured-at-load boolean; consumers see a stale value
**Severity:** P1  
**Category:** messaging  
**Location:** `src/services/emailService.js:39, 665`  
**Description:** `module.exports = { ..., EMAIL_ENABLED, ... }` — a snapshot of the env at first require. Any caller that does `if (EMAIL_ENABLED)` gets the boot-time value forever. Notification worker imports it directly (`notification_worker.js:5`).  
**Fix scope:** small — export a getter function `isEmailEnabled()`.  
**Verification:** VERIFIED-code

### P2-INT-54 — Critical alerts have a 5-minute throttle, but unhandled-rejection storms can exceed that window
**Severity:** P2  
**Category:** other  
**Location:** `src/critical-alert.js:11-26`; called from `src/server.js:200, 213`  
**Description:** `THROTTLE_MS = 5 * 60 * 1000`. If the server is in a crash loop with one rejection per second, only the first message ever gets sent and only every 5 minutes. The crash signal is suppressed.  
**Fix scope:** small — bucket by error message hash, not global timer.  
**Verification:** VERIFIED-code

### P2-INT-55 — There is no kill-switch env to globally disable all outbound integrations during incident response
**Severity:** P2  
**Category:** other  
**Description:** Per-integration switches exist (`EMAIL_ENABLED`, `WHATSAPP_ENABLED`, `VIDEO_CONSULTATION_ENABLED`, `PAYMOB_MODE`, etc.) but no umbrella `INTEGRATIONS_DISABLED=true` flag. During an incident (e.g., we've sent the wrong email to 5,000 patients) ops needs to flip a single env to halt all third-party calls.  
**Fix scope:** small — add a single `INTEGRATIONS_DISABLED` checked at the top of every send path.  
**Verification:** INFERRED (negative — searched for a kill-switch and found per-integration only)

### P3-INT-56 — Multiple integrations log token-prefix or partial values; ensure log scrubbing
**Severity:** P3  
**Category:** other  
**Location:** `src/utils/mask.js` exists but not all integration paths use it; e.g., `src/instagram/scheduler.js:126` logs `expiresIn` raw  
**Verification:** INFERRED (didn't audit every log line)

### P3-INT-57 — Two parallel WhatsApp implementations: `src/notify/whatsapp.js` (template-only) and `src/critical-alert.js` (raw text)
**Severity:** P3  
**Category:** messaging  
**Description:** Forking maintenance burden. Already covered by INT-16/19/20 individually.  
**Verification:** VERIFIED-code

---

## Appendix A — Notes on integrations the brief asked about that did not surface bugs

- **Twilio Verify base URL / version**: SDK-driven, no hardcoded URL — correct.
- **Paymob HMAC verification**: `src/paymob-hmac.js` correctly uses HMAC-SHA512 with timing-safe comparison; field order matches Paymob's documented 19-field spec; webhook handler checks HMAC before processing — correct.
- **Paymob CSRF exemption**: `src/middleware/csrf.js:83` exempts `/payments/callback`, `/portal/video/payment/callback`, and `/callback` — correctly handled.
- **Anthropic boot guard**: `src/server.js:52` enforces `ANTHROPIC_API_KEY` at boot, server exits if missing — as the brief noted.
- **CSP allows Uploadcare widget**: confirmed in `src/server.js:242-247` and `src/middleware.js:25-32`.

## Appendix B — Findings count

- P0: 9
- P1: 16
- P2: 18
- P3: 6
- N/A: 1
- Total: **50 findings**


---

# Section 06 — Background workers + crons audit

# Audit 06 — Background Workers & Crons

**Audit date:** 2026-05-06
**Scope:** Every recurring task that runs after `app.listen()` — pg-boss, node-cron, `setInterval`, `setTimeout`, lifecycle hooks.
**Stack confirmed:** Express + Postgres (pg pool max=10) + pg-boss + node-cron, multi-instance on Render with `SLA_MODE=primary` on exactly one instance.

---

## Per-worker inventory

| # | worker | cadence | started where | single-writer? | failure mode (silent vs. crash) | observability |
|---|---|---|---|---|---|---|
| 1 | `case_sla_worker.runCaseSlaSweep` (in-process) | every 5 min via setInterval | `server.js:884 startCaseSlaWorker` (only if pg-boss schedule fails) | YES — gated on `SLA_MODE=primary` | silent: outer setInterval has no try/catch around the async call (case_sla_worker.js:413) | logs "breaches/timeouts" only if non-zero; pings ops-agent heartbeat |
| 2 | `case_sla_worker.runCaseSlaSweep` (pg-boss) | cron `*/5 * * * *` | `job_queue.js:154 scheduleSlaSweep` | YES — pg-boss singletonKey `sla-primary` | re-throws to pg-boss, retries 3x with 30s delay | pg-boss internal job state; logErrorToDb on fetch failure |
| 3 | `runSlaEnforcementSweep` orchestrator | every `SLA_ENFORCEMENT_INTERVAL_MS` (default 5 min) | `server.js:892` | YES — primary only; in-process re-entry guard `slaEnforcementRunning` | silent: per-step try/catch swallows everything | logVerbose only |
| 4 | `runSlaEnforcementSweep` event-triggered | on every non-GET 2xx mutation request `finish` | `server.js:643` | primary only, but unbounded fan-in | silent | none |
| 5 | `sla_watcher.runSlaSweep` (re-exported as `runWatcherSweep`) | called from `runSlaEnforcementSweep` only | server.js:849 | indirect (via sweep) | swallowed | none |
| 6 | `sla_worker.startSlaWorker` (legacy) | dead code: `setInterval(runSweep, 5*60*1000)` (sla_worker.js:179) | NOT WIRED — server.js:877 explicitly disables | n/a | unused | none |
| 7 | `jobs/sla_watcher.runOnce` | NOT INVOKED ANYWHERE | n/a | n/a | dormant | none |
| 8 | `acceptance_watcher.startAcceptanceWatcher` | every 2 min | `server.js:886` | gated only on `SLA_MODE=primary` (server.js:875 block) | silent: try/catch in sweep, but outer setInterval has no guard | console only |
| 9 | `video_scheduler` cron | every 1 min `* * * * *` | `server.js:885` | gated on primary | silent | console + one logMajor on reminder |
| 10 | `notification_worker` | every 30s | `server.js:968` | UNCONDITIONAL — runs on BOTH primary AND passive | silent (try/catch around inner fn) | console; pings care-agent heartbeat |
| 11 | `notification_worker` initial | once at boot+5s | `server.js:971` | unconditional | silent | console |
| 12 | conversation auto-close | every 24h | `server.js:910` | unconditional — both primary AND passive | silent (try/catch ignores rowCount) | none |
| 13 | conversation auto-close initial | once at boot+5s | `server.js:909` | unconditional | silent | none |
| 14 | appointment reminders cron | `*/15 * * * *` | `server.js:920` | unconditional | silent | console line only when sends |
| 15 | campaign cron | `*/5 * * * *` | `server.js:932` | unconditional | silent | logs when triggered |
| 16 | InstagramScheduler | every 5 min | `server.js:961` | unconditional, but no-ops without `IG_ACCESS_TOKEN` | silent (per-post try/catch) | console; pings growth-agent |
| 17 | passive payment reminders | every 15 min | `server.js:900` | passive-only mode | silent | none |
| 18 | ops mac mini SSH probe | every 2 min, fires at REQUIRE-time | `routes/ops.js:51` | unconditional, on EVERY instance | silent | in-memory state only |
| 19 | pg-boss queue: `case-intelligence` | on demand (no schedule) | `job_queue.js:46` | pg-boss handles concurrency | retries 3x | pg-boss internal |
| 20 | pg-boss queue: `case-reprocess` | on demand | `job_queue.js:47` | pg-boss handles | retries 3x | pg-boss internal |
| 21 | pg-boss queue: `auto-assign` | on demand | `job_queue.js:48` | pg-boss handles | retries 3x | pg-boss internal |
| 22 | unhandled-rejection / uncaught-exception | per-event | `server.js:195,208` | n/a | exits process after 500ms | sendCriticalAlert |

---

## Findings

### P0-WORKER-1 — Notification worker runs on BOTH primary and passive instances simultaneously
**Severity:** P0
**Category:** worker
**Location:** src/server.js:967-974
**Description:** The notification worker `setInterval` is registered outside the `if (CONFIG.SLA_MODE === 'primary')` block, so every Render instance pulls from `notifications WHERE status IN ('queued','retry')`, then races to UPDATE the row. There is no `SELECT … FOR UPDATE SKIP LOCKED` and no row-level claim. With N instances, every notification has up to N concurrent send attempts before the first instance updates `status` to `sent`/`failed`.
**Impact:** Duplicate WhatsApp + duplicate emails per notification on multi-instance deploys. On a 2-instance setup that means every patient gets 2x the SMS volume, doubling Twilio/Meta cost AND running into Meta WhatsApp template per-user rate limits. Pre-launch this is a P0 fraud-risk-shaped bug because it also re-fires payment reminders.
**Fix scope:** small — gate the registration on `CONFIG.SLA_MODE === 'primary'` (or add `SELECT … FOR UPDATE SKIP LOCKED` row-claim with an `UPDATE notifications SET status='sending' WHERE id=$1 AND status IN ('queued','retry') RETURNING *` two-phase fetch).
**Verification:** VERIFIED-code

### P0-WORKER-2 — Conversation auto-close runs on every instance with no idempotency window
**Severity:** P0
**Category:** worker
**Location:** src/server.js:907-914, src/routes/messaging.js:396-411
**Description:** `closeStaleConversations` is registered as a 24h interval AND a +5s boot run on every instance, regardless of SLA_MODE. The query has no instance gating and no row-lock. On multi-instance the same UPDATE fires from each box.
**Impact:** Repeated UPDATE storms on `conversations.updated_at`/`closed_at` on each Render boot — minor cost, but more importantly the +5s boot run executes during DB warm-up and can spike pool. The 24h interval also has no `.unref()` so it pins the event loop after SIGTERM.
**Fix scope:** small — gate on primary; add `.unref()`.
**Verification:** VERIFIED-code

### P0-WORKER-3 — `setInterval` callbacks call async functions with no error handling → unhandled rejection → process exit
**Severity:** P0
**Category:** worker
**Location:** src/case_sla_worker.js:413-419; src/workers/acceptance_watcher.js:152
**Description:** Inside `startCaseSlaWorker`:
```js
setInterval(() => { try { runCaseSlaSweep(); } catch (err) { logFatal(...) } }, intervalMs);
```
The `try/catch` is synchronous — `runCaseSlaSweep()` returns a Promise, so a rejection escapes the try and surfaces as an `unhandledRejection`. Server.js:195 has a guardrail that calls `process.exit(1)` on unhandledRejection. So if any tick rejects, the process crashes. Same pattern in acceptance_watcher.js:152: `setInterval(runAcceptanceWatcherSweep, 2*60*1000)` — the function does try/catch internally, so safer there, but it returns nothing; if it ever throws synchronously before its try block (e.g. require failure), same crash.
**Impact:** A single transient DB error in `fetchSlaCandidates` (which now intentionally rethrows per the comment block at case_sla_worker.js:389-393) crashes the Render instance whenever the in-process fallback path is active (pg-boss unavailable). The crash guard pattern is good for unknown bugs but here is a known interaction.
**Fix scope:** small — wrap as `setInterval(() => { runCaseSlaSweep().catch(err => logFatal(...)); }, ...)`.
**Verification:** VERIFIED-code

### P0-WORKER-4 — Video scheduler stale-slot notifications use wrong field name; auto-cancel notifications never reach anyone
**Severity:** P0
**Category:** worker
**Location:** src/video_scheduler.js:252-285
**Description:** `queueNotification` requires `toUserId` (src/notify.js:221). The `sweepStalePendingSlots` function calls it with `userId:` (line 253) and with no userId at all for admin alerts (`type: 'admin_alert'` is not a recognized parameter). `queueNotification` returns `{ok: false, skipped: true, reason: 'invalid_to_user_id'}` and the row is never inserted.
**Impact:** When a video slot ages past 24h or 48h, the patient never gets the auto-cancel WhatsApp, the admin never gets the stale-slot escalation, and the 48h auto-cancel side effect (refund, status update) silently runs without any notification. Fails the SLA "tell the user we cancelled" promise.
**Fix scope:** small — rename `userId` → `toUserId`; for admin alerts, look up the actual superadmin id (already done in sla_watcher.js:12 helper).
**Verification:** VERIFIED-code

### P0-WORKER-5 — Both event-triggered AND interval SLA sweeps fire concurrently with only an in-process re-entry guard
**Severity:** P0
**Category:** worker / pool
**Location:** src/server.js:629-648 (event), src/server.js:892 (interval), src/server.js:830 (`slaEnforcementRunning` boolean)
**Description:** Every non-GET 2xx mutation (~doctor/admin/patient orders endpoints) schedules `setTimeout(runSlaEnforcementSweep, 0)` on `res.on('finish')`. The 5-minute interval also fires it. The re-entry guard `slaEnforcementRunning` is a JS boolean — only protects within ONE process. On the primary instance under load (e.g. an admin doing 20 mutations in 30s), the very first sweep runs; subsequent ticks no-op silently. If two ticks land on different ticks of the event loop while one is still awaiting on `withTransaction`, the protection holds. But the sweep itself does FOUR sequential things (runWatcherSweep, runSlaReminderJob, dispatchUnpaidCaseReminders, sweepExpiredDoctorAccepts), each taking pool connections. Combined with the periodic 5-min one, peak load can saturate the pool.
**Impact:** Pool saturation analogue of the known foundational bug. A long-running mutation triggers a sweep that holds 1-2 of the 10 pool slots; another mutation triggers another tick; if the boolean was already cleared between them, two sweeps run, each opening a transaction. Request handlers stuck on `pool.connect`.
**Fix scope:** medium — replace the JS boolean with a Postgres advisory lock (`pg_try_advisory_lock(<sla-sweep>)`), AND drop the event-triggered tick (it duplicates the interval).
**Verification:** VERIFIED-code

### P0-WORKER-6 — `runSlaReminderJob` holds two long transactions that lock per-row UPDATEs across the whole orders table scan
**Severity:** P0
**Category:** pool / queue
**Location:** src/server.js:1023-1105
**Description:** The reminder transaction (`withTransaction` line 1035) runs `SELECT … FROM orders WHERE deadline_at IS NOT NULL AND completed_at IS NULL …` (no LIMIT) and then for EACH row issues `queueNotification` (which calls `pool.query` independently — using a different pool client) AND `client.query('UPDATE orders SET sla_reminder_sent…')` AND `logOrderEvent`. With even 100 in-flight orders, this transaction can hold a connection for 30+ seconds on Supabase pgbouncer. The breach transaction (line 1061) is even worse: it issues PER-ROW `SELECT status, breached_at WHERE id = $1`, then UPDATE, then `issueBreachRefundSafe` (which does its own pool queries — potentially blocking on the same pool), then per-ops-user `queueNotification` (more pool queries).
**Impact:** Pool starvation matches the known foundational bug. With pool max=10, a single sweep over 100 orders × 5+ pool ops each = 500+ pool acquisitions while the outer transaction client is parked. `withTransaction` calls `pool.connect()` and releases at the end; but every `queueNotification`/`logOrderEvent` inside the loop calls `pool.query` from the SHARED pool, not the locked client.
**Fix scope:** medium — re-architect: SELECT candidates without a transaction, then per-row open a small transaction, OR cap the loop to LIMIT 50 with cursor.
**Verification:** VERIFIED-code

### P0-WORKER-7 — `dispatchUnpaidCaseReminders` (sweep mode) has no LIMIT on the inner loop dispatch and no rate limit
**Severity:** P0
**Category:** pool
**Location:** src/case_lifecycle.js:457-504
**Description:** When called with no args (the sweep path), it does `SELECT * FROM orders WHERE … LIMIT $N` (default 200), then for each row recursively calls `dispatchUnpaidCaseReminders(r, {force})`. Each per-row call does multiple writes — `UPDATE orders SET status = 'expired_unpaid'`, `UPDATE orders SET deleted_at`, plus `queueNotification` calls. 200 cases × 4 pool ops = 800 connection acquisitions, all from the same pool that serves request handlers.
**Impact:** Same pool starvation. The function is called from `runSlaEnforcementSweep` (every 5 min on primary) AND directly from the passive 15-min interval (server.js:900). On primary, this runs on top of the breach transaction.
**Fix scope:** medium — chunk + sleep between batches; or move to pg-boss as a paged job.
**Verification:** VERIFIED-code

### P0-WORKER-8 — Mac-mini SSH probe runs at module-require time (before DB ready) and on every instance
**Severity:** P0
**Category:** worker
**Location:** src/routes/ops.js:42-52
**Description:** `setInterval(refreshMacMiniStatus, 2 * 60 * 1000)` is at the TOP LEVEL of `routes/ops.js`. As soon as that module is required (during `app.use('/ops', opsRoutes)` registration in server.js), the interval starts and the SSH `exec` runs immediately. This (a) runs before `_dbReady` resolves, (b) runs on EVERY Render instance, including passive, and (c) attempts SSH to `OPS_SSH_HOST` even if it isn't set (the function early-exits in that case, so OK there). The interval is also never cleared — gracefulShutdown doesn't track it.
**Impact:** Multiple instances ping the mac mini every 2 min. SSH exec spawns a child process — if the host is unreachable, it waits 5s × instances. After SIGTERM, the interval keeps the process alive.
**Fix scope:** small — move interval-start to a `start()` function called once from server.js after boot; gate on a single instance; `.unref()` the interval.
**Verification:** VERIFIED-code

### P0-WORKER-9 — pg-boss SLA singleton uses sched key 'sla-primary' but the in-process fallback is also enabled if pg-boss returns false
**Severity:** P0
**Category:** queue / worker
**Location:** src/server.js:880-884; src/job_queue.js:151-157
**Description:** The boot path is:
```js
slaBoss = await scheduleSlaSweep();
if (!slaBoss) startCaseSlaWorker();
```
`scheduleSlaSweep` returns `false` ONLY if `boss` is null (job queue init failed). If pg-boss starts on a primary instance but the `boss.schedule()` call THROWS (e.g. duplicate schedule conflict, network blip), the catch at server.js:881 logs and falls back to `startCaseSlaWorker` — but the pg-boss schedule may still be persisted in `pgboss.schedule` from a prior boot. So both could run concurrently.
**Impact:** Double SLA sweep marks orders as breached twice, fires duplicate notifications, double-attempts refunds (idempotency at sla_breach.js helps, but every fallback tick wastes pool).
**Fix scope:** small — make `scheduleSlaSweep` upsert/idempotent, and have a single source of truth (only fall back if `boss` is null).
**Verification:** VERIFIED-code

### P0-WORKER-10 — pg-boss `sla-sweep` queue created at server.js:42, but `boss.work('sla-sweep', …)` is only attached inside `scheduleSlaSweep`; if that path fails, queue exists but has no consumer
**Severity:** P0
**Category:** queue
**Location:** src/job_queue.js:42 (createQueue), src/job_queue.js:153 (work registration)
**Description:** Queue creation is unconditional at startJobQueue. The worker is only registered inside `scheduleSlaSweep`. If `scheduleSlaSweep` throws after `createQueue` but before `boss.work`, jobs published by `boss.schedule` (which `pg-boss` may have persisted from a prior boot) pile up in `pgboss.job` with no consumer.
**Impact:** Silent backlog. Hard to detect without manually inspecting the pgboss schema.
**Fix scope:** small — register the worker at queue-creation time, regardless.
**Verification:** VERIFIED-code

### P1-WORKER-11 — Notification worker has no `.unref()`; SIGTERM cannot exit cleanly
**Severity:** P1
**Category:** worker
**Location:** src/server.js:968-970
**Description:** `setInterval(async function() {...}, 30000)` returns a Timeout that pins the event loop. `gracefulShutdown` (server.js:989) calls `clearInterval(slaSweepIntervalId)` but the notification worker interval id is never captured, never cleared. Same for the campaign cron, appointment reminder cron, conversation auto-close interval, IG scheduler, mac-mini probe, acceptance watcher, video scheduler.
**Impact:** SIGTERM hits the 10s force timer at server.js:991 every shutdown — ungraceful. On Render, this means in-flight requests get killed when the deployer sends SIGTERM and the force-exit fires.
**Fix scope:** small — track each interval id, clear in gracefulShutdown; or call `.unref()` on every interval that doesn't need to pin the event loop.
**Verification:** VERIFIED-code

### P1-WORKER-12 — `setInterval(slaSweepIntervalId)` calls `.unref()` (good) but the function is `runSlaEnforcementSweep` which spawns 4 sub-sweeps, none isolated
**Severity:** P1
**Category:** worker
**Location:** src/server.js:892-895; 848-862
**Description:** The aggregator runs four functions sequentially, each wrapped in its own try/catch. If `runWatcherSweep` (which is `sla_watcher.runSlaSweep`) hangs on a transaction (it uses `withTransaction` per breach in a loop, line 115), the next sub-sweeps don't run on this tick. They will run next tick (5 min later), but during the hang `dispatchUnpaidCaseReminders` is delayed.
**Impact:** Watcher sweep stalls block reminder delivery. With 100 breaches × per-breach withTransaction, this realistically takes 30-90s; under pool contention possibly minutes.
**Fix scope:** medium — run the four sweeps in parallel with `Promise.allSettled`; cap each with a per-sweep timeout.
**Verification:** VERIFIED-code

### P1-WORKER-13 — `runWatcherSweep` (`sla_watcher.runSlaSweep`) does `WHERE status IN ('new','accepted','in_review')` WHERE 'new' is for unpaid cases — likely scan over orders that should be paid first
**Severity:** P1
**Category:** worker
**Location:** src/sla_watcher.js:36
**Description:** The sweep filters to `('new','accepted','in_review')` but downstream `case_sla_worker.runCaseSlaSweep` filters to `('in_review','rejected_files')`. There are TWO different SLA breach paths running in the same primary tick (server.js:849, 850 and case_sla_worker via pg-boss). They UPDATE the same rows with different transitions.
**Impact:** Duplicate SLA breach event + duplicate reassignment notifications; rare race conditions where one path sets `breached_at` and the other immediately reassigns based on stale state. Audit trail has duplicate "SLA breached" events.
**Fix scope:** large — consolidate to one breach pipeline. Pick `case_sla_worker` (newer, has refund hook) and remove the `runWatcherSweep` call from server.js:849.
**Verification:** VERIFIED-code

### P1-WORKER-14 — `sla_watcher.runSlaSweep` scans `orders` with NO LIMIT, no time bound, no index hint
**Severity:** P1
**Category:** pool
**Location:** src/sla_watcher.js:33-40
**Description:** The query is unbounded:
```sql
SELECT * FROM orders WHERE status IN ('new','accepted','in_review') AND sla_hours IS NOT NULL AND deadline_at IS NOT NULL AND (payment_status IS NULL OR payment_status = 'paid')
```
With months of growth, this scans the entire active set every 5 min. No index on `(status, deadline_at)` is mandated.
**Impact:** Slow sweep tail. Already on the bug pattern list.
**Fix scope:** small — add LIMIT 500 and index `idx_orders_status_deadline`.
**Verification:** VERIFIED-code

### P1-WORKER-15 — `sla_watcher.runSlaSweep` per-breach `withTransaction` + per-row `queueNotification` inside the transaction holds the locked client across multiple pool ops
**Severity:** P1
**Category:** pool
**Location:** src/sla_watcher.js:115-216
**Description:** Inside `withTransaction(async (client) => {...})` the code calls `await queueNotification(...)` (which uses the shared pool, not the client). With pool max=10 and 1 client locked by the transaction, every call inside the transaction acquires another connection from the same pool. Under concurrent breach reassignments, this leads to lock-wait + pool exhaustion.
**Impact:** Pool starvation under breach storms.
**Fix scope:** medium — refactor: do DB updates inside the transaction; queue notifications AFTER COMMIT, in a follow-up loop.
**Verification:** VERIFIED-code

### P1-WORKER-16 — `case_sla_worker.runCaseSlaSweep` calls `pingOps` via plain HTTP to `localhost:PORT` — hangs forever if the server is shutting down
**Severity:** P1
**Category:** worker
**Location:** src/case_sla_worker.js:387, 398-407 (pingOps)
**Description:** `pingOps` does `http.request({hostname: 'localhost', port: ...})`. The connection has no timeout. If the server is mid-shutdown, this hangs indefinitely. Same pattern in src/notification_worker.js:295,298-307 and src/instagram/scheduler.js:115,131-140.
**Impact:** Workers that ping ops can hold open sockets at shutdown. The error handler is `req.on('error', function() {})` (silent), but no timeout means a half-open socket may never error.
**Fix scope:** small — add `req.setTimeout(2000); req.on('timeout', () => req.destroy())`.
**Verification:** VERIFIED-code

### P1-WORKER-17 — Acceptance watcher uses `doctor_specialties` join, but the rest of the codebase uses `users.specialty_id`
**Severity:** P1
**Category:** worker
**Location:** src/workers/acceptance_watcher.js:56-70
**Description:** The query joins:
```sql
JOIN doctor_specialties ds ON ds.doctor_id = u.id WHERE ds.specialty_id = $1
```
But `case_sla_worker.buildAlternateDoctorQuery` (lines 32-72) uses `users.specialty_id` directly. The two are different schemas — `doctor_specialties` is for multi-specialty doctors, `users.specialty_id` is the legacy single column. Whichever is the source of truth, one of these is wrong.
**Impact:** Auto-assignment may pick the wrong doctor (or none) when the case is created with an `acceptance_deadline_at`. Either:
- Most doctors have `users.specialty_id` set but no `doctor_specialties` row → acceptance watcher finds nobody, logs "no available doctor", case sits broken;
- Or doctors have both, in which case different paths route to different doctors.
**Fix scope:** small — pick one path; align with the breach worker's query.
**Verification:** VERIFIED-code

### P1-WORKER-18 — Acceptance watcher hardcodes `'superadmin-1'` as admin recipient
**Severity:** P1
**Category:** worker
**Location:** src/workers/acceptance_watcher.js:137
**Description:** `queueNotification({ toUserId: 'superadmin-1', ... })`. If that user doesn't exist (or is renamed in production), every auto-assign skips the admin notification. `notify.js:normalizeToUserId` may return null for unknown ids, and the row is silently dropped.
**Impact:** Admins miss every auto-assignment notification. Same pattern in src/notify.js:418, 443.
**Fix scope:** small — query the actual list of superadmins (mirror sla_watcher.js:12).
**Verification:** VERIFIED-code

### P1-WORKER-19 — Video scheduler `detectNoShows` runs every minute with NO LIMIT and unfiltered scan
**Severity:** P1
**Category:** pool
**Location:** src/video_scheduler.js:96-106
**Description:** `SELECT a.*, vc.* FROM appointments a LEFT JOIN video_calls vc ... WHERE a.status = 'confirmed' AND a.scheduled_at < $1` (no LIMIT, no upper bound). After 6 months of confirmed appointments, this returns the full backlog every minute. The 30-min boundary means the same row appears every tick until status updates land.
**Impact:** Re-scan of cumulative no-show backlog every minute. With Render Postgres and even 1k confirmed appointments, this is wasted I/O.
**Fix scope:** small — add upper bound `AND a.scheduled_at > $2` (e.g. 24h ago); add LIMIT 200.
**Verification:** VERIFIED-code

### P1-WORKER-20 — Video scheduler `sweepStalePendingSlots` runs every minute (not just every 24h or 48h)
**Severity:** P1
**Category:** worker
**Location:** src/video_scheduler.js:303-307
**Description:** The cron is `* * * * *` (1/min). Inside, the sweep selects ALL pending_doctor or reschedule_proposed slots, then evaluates `ageHours >= 24` per row. The dedupe key prevents notification spam, but the sweep itself runs every minute.
**Impact:** Wasted query traffic. With 100 stale slots, that's 100 row evaluations per minute = 144,000 per day, all to send 0 new notifications most ticks.
**Fix scope:** small — move stale-slot sweep to its own cron (every 1h is enough).
**Verification:** VERIFIED-code

### P1-WORKER-21 — `runSlaReminderJob` updates `orders.updated_at` on every reminder send
**Severity:** P1
**Category:** worker
**Location:** src/server.js:1052
**Description:** `UPDATE orders SET sla_reminder_sent = true, updated_at = $1 WHERE id = $2`. `updated_at` is treated as a meaningful audit field elsewhere (case_lifecycle.js uses it as a fallback for `assigned_at` in `fetchDoctorTimeouts`). Bumping `updated_at` for a passive reminder distorts that semantic. Same pattern at server.js:1074 for breach + at sla_watcher.js:121, 178.
**Impact:** Fallback for "when was this case assigned" returns the timestamp of a reminder, not assignment. Combined with the fallback in `fetchDoctorTimeouts`, doctor-response timeout calculations may slip by hours each time a reminder fires.
**Fix scope:** small — don't touch `updated_at` for reminder bookkeeping; OR rely solely on `sla_reminder_sent`.
**Verification:** VERIFIED-code

### P1-WORKER-22 — `dispatchUnpaidCaseReminders` two-param `deleted_at` workaround documents a schema bug that is not on the schema fix list
**Severity:** P1
**Category:** worker
**Location:** src/case_lifecycle.js:537-543
**Description:** The comment explicitly notes `orders.deleted_at` is `timestamp with time zone` while `orders.updated_at` is `timestamp without time zone`, requiring two separate `$1`/`$2` parameters with the same value to avoid a Postgres type-deduction error. The audit comment marks this as TECH DEBT but the schema migration is "deferred."
**Impact:** Forever workaround. Any future writer that reuses the same parameter binding will hit the same error and silently fail (the function returns `{ok:false}` without crashing).
**Fix scope:** medium — schema migration to align the two columns to one tz semantic.
**Verification:** VERIFIED-code

### P1-WORKER-23 — Campaign cron grabs scheduled campaign IDs in a loop and uses `setImmediate` with a captured `ci` variable inside a `for var` loop
**Severity:** P1
**Category:** cron
**Location:** src/server.js:932-953
**Description:**
```js
for (var ci = 0; ci < scheduled.length; ci++) {
  ...
  setImmediate(function() { try { processCampaign(scheduled[ci].id); } catch (_) {} });
}
```
Classic var-hoisting bug — by the time `setImmediate` fires, `ci === scheduled.length`, so `scheduled[ci]` is undefined, and `processCampaign(undefined)` is called. The try/catch swallows it. The earlier `await execute("UPDATE … WHERE id = $1 AND status='scheduled' AND approved_by IS NOT NULL")` already moved the campaign to 'sending', so it's now stuck in 'sending' with nobody processing.
**Impact:** Campaigns that hit the scheduler simultaneously: only the LAST one is processed (and even that's racy because `scheduled[ci]` may already be the last). Approved campaigns stuck in 'sending' status, no recipients ever emailed.
**Fix scope:** small — change `var ci` to `let ci`, or capture the id in a variable inside the loop.
**Verification:** VERIFIED-code

### P1-WORKER-24 — `processCampaign` recursive `setTimeout` chain (200ms per email) holds the request close inside a single Node turn
**Severity:** P1
**Category:** cron
**Location:** src/routes/campaigns.js:301-372
**Description:** For 1000 recipients × 200ms = 200s of sustained activity in a single setTimeout chain. There is no error handler that stops the chain on repeated failures. If `sendEmailFn` rejects synchronously (not a Promise), the chain stops without updating `email_campaigns.status`.
**Impact:** Campaign processing can stall mid-send and leave campaigns in 'sending' forever. No recovery on restart — `processCampaign` is fire-and-forget from the cron, so a Render restart drops the in-memory state.
**Fix scope:** medium — convert to pg-boss with one job per recipient; persistent retries.
**Verification:** VERIFIED-code

### P1-WORKER-25 — `closeStaleConversations` returns rowCount but server.js wraps it in `try{closeStaleConversations()}catch(_){}` — return is discarded, errors silenced
**Severity:** P1
**Category:** observability
**Location:** src/server.js:909-910; src/routes/messaging.js:396-411
**Description:** The function already swallows errors (try/catch returns 0). The caller silently fires-and-forgets. There's NO logging when conversations close, no alarm if it fails to run.
**Impact:** Auto-close could be silently broken for weeks. Patients can't reopen conversations because the schema "closed within 7 days" check is what gates reopen — but if auto-close never ran, conversations are still 'active' and reopen logic doesn't fire.
**Fix scope:** small — log row count when > 0; surface errors.
**Verification:** VERIFIED-code

### P1-WORKER-26 — IG scheduler does not check `IG_ACCESS_TOKEN` expiry; `refreshToken` exists but is never invoked
**Severity:** P1
**Category:** cron / observability
**Location:** src/instagram/scheduler.js:23-41, 121-128
**Description:** `start()` only checks token presence. `refreshToken()` is implemented but no schedule wires it up. Long-lived Meta IG tokens expire every 60 days. After that, every `publishDuePosts` call fails with 401, the post is marked `failed`, and the queue silently grows.
**Impact:** Instagram publishing dies silently after 60 days with no alert.
**Fix scope:** small — schedule monthly refreshToken; alert on consecutive 401s.
**Verification:** VERIFIED-code

### P1-WORKER-27 — `seedPricingData` runs at every boot inside `migrate()` (db.js:48); only no-ops if `service_regional_prices` has rows, but the check is itself a query
**Severity:** P1
**Category:** boot
**Location:** src/db.js:78-84
**Description:** Runs on every boot of every instance. The early-return at line 84 is a `SELECT COUNT(*)` against `service_regional_prices` — fast on indexed table but still a roundtrip. If the boot DB is unreachable transiently, every boot retries the seed via the migrate path.
**Impact:** Minor. But on multi-instance boots (Render rolling deploy), all instances run migrate concurrently — could race on the schema_migrations INSERT. Migrations are wrapped in transactions per-file but `runDataFixups` and `seedPricingData` are not.
**Fix scope:** small — wrap fixup/seed in advisory lock; or run only on instance #0.
**Verification:** VERIFIED-code

### P2-WORKER-28 — Notification worker uses `LIMIT 50` in the SELECT but the worker runs every 30s; under burst (>50 queued/sec) backlog grows unbounded
**Severity:** P2
**Category:** queue
**Location:** src/notification_worker.js:199-211
**Description:** Throughput cap = 50 / 30s = 1.67/sec sustained. SLA reminder + payment reminder + appointment reminder + breach notifications spike during the daily 9am-12pm window. WhatsApp send is 200-800ms each, so processing 50 takes 10-40s — already eating most of the 30s window. Coupled with retries, can fall behind and never catch up.
**Impact:** Notification delivery falls behind. Patients see "your case was reassigned" 30+ minutes after the actual reassignment.
**Fix scope:** medium — move to pg-boss with a worker pool; raise effective rate via teamSize.
**Verification:** VERIFIED-code

### P2-WORKER-29 — Notification worker exponential backoff math: `30000 * 4^(attempts-1)` → 30s, 120s, 480s, then 'failed'; but `MAX_RETRIES=3` means `failed` after 2 retries (3 attempts), so the 480s slot is unreachable
**Severity:** P2
**Category:** worker
**Location:** src/notification_worker.js:269-273
**Description:** Comment says "30s, 120s, 480s" but with MAX_RETRIES=3 attempts, the third attempt is the last and goes straight to 'failed'. The 480s computation is dead code.
**Impact:** Lower retry resilience than the comment promises. Real schedule is 30s → 120s → fail. Email/WhatsApp transient failures (DNS, 503) pass through too quickly.
**Fix scope:** small — bump MAX_RETRIES to 4 to match the comment, or fix the comment.
**Verification:** VERIFIED-code

### P2-WORKER-30 — `runNotificationWorker` queries `SELECT *` from notifications without column whitelist; later `n.attempts` and `n.retry_after` are read but not validated
**Severity:** P2
**Category:** worker
**Location:** src/notification_worker.js:204-209
**Description:** `SELECT *` is fine for now but the notifications table grows columns over time. Schema drift (e.g. someone adds a giant `metadata` JSONB) inflates per-row row size and caches.
**Impact:** Slow query growth.
**Fix scope:** small — explicit column list.
**Verification:** VERIFIED-code

### P2-WORKER-31 — pg-boss config: `expireInSeconds: 15*60` means a stuck SLA sweep job is reaped after 15 min; if pool is genuinely starved, the 5-min schedule overruns and pg-boss may queue duplicates
**Severity:** P2
**Category:** queue
**Location:** src/job_queue.js:25
**Description:** With `expireInSeconds=900` and a `*/5` schedule, if a sweep takes 6 min, pg-boss schedules another while the first is running. SingletonKey prevents two from running simultaneously, but the queue can have 1 active + 1 pending. Under sustained pool starvation, this never recovers.
**Impact:** Cascading sweep backlog under stress.
**Fix scope:** small — either lower expire or alert on long-running sweeps.
**Verification:** INFERRED — depends on pg-boss internal behavior under singletonKey + retry.

### P2-WORKER-32 — `pingOps` http requests fire from THREE workers (case_sla_worker, notification_worker, instagram/scheduler) but write to a single `agent_heartbeats` table with `pinged_at`-only ordering
**Severity:** P2
**Category:** observability
**Location:** src/case_sla_worker.js:387; src/notification_worker.js:295; src/instagram/scheduler.js:115
**Description:** The ops dashboard shows "DISTINCT ON (agent_name) agent_name, status, current_task, pinged_at FROM agent_heartbeats ORDER BY agent_name, pinged_at DESC" so only the latest ping per agent name is shown. There is no per-WORKER heartbeat — `ops-agent` is a catch-all for the SLA sweep AND any other ops-agent ping. No way to tell from the dashboard whether the breach worker ran in the last 5 min.
**Impact:** Worker liveness is invisible to operators. A dead notification_worker takes hours to discover (only via "patients aren't getting WhatsApp"). The /ops/agent/cleanup endpoint deletes >30 days but there's no alerting on stale agents.
**Fix scope:** medium — separate heartbeat per worker; render "last seen" with red flag if > 2× expected interval.
**Verification:** VERIFIED-code

### P2-WORKER-33 — Acceptance watcher does NOT check `is_paused` doctors; could re-assign a case to a paused doctor
**Severity:** P2
**Category:** worker
**Location:** src/workers/acceptance_watcher.js:60-70
**Description:** The query checks `is_active` and `is_available` but NOT `is_paused`. `case_sla_worker.buildAlternateDoctorQuery` (line 36) explicitly excludes `is_paused`. Inconsistency means an SLA-paused doctor (auto-paused for breach threshold) could still receive a fresh acceptance-timeout case.
**Impact:** Doctor pause logic bypassed via the acceptance-timeout path.
**Fix scope:** small — add `AND COALESCE(u.is_paused, false) = false`.
**Verification:** VERIFIED-code

### P2-WORKER-34 — `appointment_reminders` cron + `video_scheduler` cron + `case_sla_worker` cron all fire on the 5/15/30/60-minute boundary at the same time
**Severity:** P2
**Category:** cron
**Location:** src/server.js:920 (`*/15 * * * *`), src/server.js:932 (`*/5 * * * *`), src/job_queue.js:154 (`*/5 * * * *`), src/video_scheduler.js:303 (`* * * * *`)
**Description:** At minute 0 of every hour, FOUR crons fire simultaneously: appointment reminders, campaign cron, pg-boss SLA sweep, video scheduler. Each grabs at least 1-2 pool connections. Add the request load — total burst = 8-12 connections in a 1-2s window. Pool max=10.
**Impact:** Periodic pool spikes at hh:00, hh:15, hh:30, hh:45.
**Fix scope:** small — stagger crons with offset minutes (`5,20,35,50` etc.).
**Verification:** VERIFIED-code

### P2-WORKER-35 — `runSlaEnforcementSweep` writes `[SLA] enforcement sweep ran (interval)` only at logVerbose level; default deploy doesn't log it
**Severity:** P2
**Category:** observability
**Location:** src/server.js:857
**Description:** No way to confirm sweeps are running by tailing logs. Combined with the lack of heartbeat for SLA sweep specifically, only error logs surface — and only when something throws.
**Impact:** "Did the sweep run today?" requires querying the DB or hitting /ops.
**Fix scope:** small — log at major level once per hour with summary stats.
**Verification:** VERIFIED-code

### P2-WORKER-36 — Boot order: setTimeout(boot SLA sweep, 1000) at server.js:888 fires BEFORE app.listen completes
**Severity:** P2
**Category:** boot
**Location:** src/server.js:888-890; 977 (app.listen is *after* the SLA setup block)
**Description:** Setup order in the `_dbReady.then` block:
1. `await startJobQueue` (line 871)
2. SLA primary block, including `setTimeout(runSlaEnforcementSweep, 1000)` (line 888)
3. Conversation auto-close, appointment reminders, etc.
4. `app.listen(PORT)` (line 977)

The 1000ms boot SLA sweep starts running before the HTTP server starts. The first sweep does `pingOps` via HTTP to `localhost:PORT`, which will fail (connection refused) — but with `req.on('error', () => {})` swallowing it.
**Impact:** First heartbeat is lost. Minor.
**Fix scope:** small — register everything but defer interval starts to inside `app.listen` callback.
**Verification:** VERIFIED-code

### P2-WORKER-37 — Multiple workers depend on `services/emailService` via `try { require } catch {}` — silent skip if module fails to load
**Severity:** P2
**Category:** worker
**Location:** src/jobs/appointment_reminders.js:11-13; src/notification_worker.js:5
**Description:** `try { sendEmailFn = require('../services/emailService').sendEmail; } catch (_) {}`. If the require throws (e.g. `RESEND_API_KEY` missing), the worker silently runs with `sendEmailFn = null` and emails never go out. There's no log of the failure.
**Impact:** Email delivery silently disabled if config is missing on a deploy.
**Fix scope:** small — log the require failure.
**Verification:** VERIFIED-code

### P2-WORKER-38 — `sla_worker.js` (legacy `startSlaWorker`) is dead code but still has `module.exports = { startSlaWorker, runSlaSweep }`
**Severity:** P2
**Category:** worker
**Location:** src/sla_worker.js:1-185
**Description:** The comment at server.js:877 confirms it's disabled. But the module is still exported. Future code may re-import and re-enable the duplicate breach loop accidentally.
**Impact:** Footgun.
**Fix scope:** small — delete the file.
**Verification:** VERIFIED-code

### P2-WORKER-39 — `jobs/sla_watcher.runOnce` is exported but never called from anywhere
**Severity:** P2
**Category:** worker
**Location:** src/jobs/sla_watcher.js:108-110
**Description:** Third dead breach implementation (after sla_worker.js and sla_watcher.js (root) and case_sla_worker.js — it's the FOURTH). `runOnce` is exported but no caller. The file requires `node-cron` at top but no `cron.schedule` is set up — module is dormant.
**Impact:** Footgun — three dead breach implementations.
**Fix scope:** small — delete.
**Verification:** VERIFIED-code

### P2-WORKER-40 — `runAppointmentReminders` updates `reminder_24h_sent` and `reminder_1h_sent` AFTER queueing notifications — race window
**Severity:** P2
**Category:** worker
**Location:** src/jobs/appointment_reminders.js:36-40, 57-61
**Description:** Order of operations:
1. SELECT appointments where `reminder_24h_sent = false`
2. For each, `await sendReminder(appt, '24h')` (queues + dispatches)
3. `UPDATE appointments SET reminder_24h_sent = true`

If the cron runs every 15 min and a previous tick is still in step 2 (because `sendReminder` does multi-channel queue + email send, which can take seconds with Resend latency), the next tick re-fetches the same row (still `reminder_24h_sent = false`) and re-queues.
**Impact:** Duplicate reminders during overlapping ticks. The dedupe key inside `queueMultiChannelNotification` saves us, but the email send via direct `sendEmailFn` in line 83 has NO dedupe — patient gets 2 reminder emails.
**Fix scope:** small — flip `reminder_24h_sent` BEFORE dispatching (or use FOR UPDATE SKIP LOCKED).
**Verification:** VERIFIED-code

### P2-WORKER-41 — IG scheduler `setTimeout(3000)` between posts is awaited inside the for loop; if 5 posts are due, total wall time = 15s minimum
**Severity:** P2
**Category:** worker
**Location:** src/instagram/scheduler.js:113
**Description:** Sequential 3s sleep between posts. With 5 due posts, the `publishDuePosts` call holds for 15s + per-post API time. Re-runs every 5 min — fine. But if the IG API hangs (no timeout in `publisher.publishImage`), the whole worker hangs and skips ticks.
**Impact:** Stuck IG posts can pause publishing for hours.
**Fix scope:** small — per-post timeout via `Promise.race`.
**Verification:** VERIFIED-code

### P3-WORKER-42 — `runSlaReminderJob` logs `[SLA job] completed in {ms}ms` only if `sweepDurationMs > 1000` or work was done
**Severity:** P3
**Category:** observability
**Location:** src/server.js:1102
**Description:** Quiet success path means logs hide the typical fast-path. Hard to tell from a log graph "is the sweep running every 5 min as expected?"
**Impact:** Minor observability gap.
**Fix scope:** small — log at debug or always-major.
**Verification:** VERIFIED-code

### P3-WORKER-43 — `runCaseSlaSweep` rethrows on fetch failure to give pg-boss a retry signal, but the in-process fallback at case_sla_worker.js:413 has NO retry — a single failed fetch loses that 5-min tick
**Severity:** P3
**Category:** worker
**Location:** src/case_sla_worker.js:389-393, 413-419
**Description:** When pg-boss is the scheduler, retries kick in. When the in-process fallback runs, the rethrow surfaces as an unhandled rejection (per P0-WORKER-3 above), crashing the server. So either retries kick in or the server crashes — no in-between.
**Impact:** Asymmetric resilience.
**Fix scope:** small — wrap setInterval body in `.catch(...)` (overlaps with P0-WORKER-3).
**Verification:** VERIFIED-code

### P3-WORKER-44 — Crash guards (server.js:195, 208) call `process.exit(1)` on every unhandledRejection — but ALSO call `sendCriticalAlert(...)` SYNC before exit; if alert is slow, exit may race
**Severity:** P3
**Category:** worker
**Location:** src/server.js:193-218
**Description:** `sendCriticalAlert` is presumably async. The `setTimeout(..., 500)` at line 204/217 gives 500ms to send. Critical alerts are throttled (1/5min per critical-alert.js) so the alert may not even fire if it just fired.
**Impact:** Silent process death without alert during alert-throttle window.
**Fix scope:** small — log the alert outcome before exit.
**Verification:** INFERRED

### P3-WORKER-45 — `withTransaction` does not set a statement_timeout — a slow query inside a worker hangs the whole transaction
**Severity:** P3
**Category:** pool
**Location:** src/pg.js:95-108
**Description:** No `SET LOCAL statement_timeout = '30s'` inside the transaction. A long-running scan inside a worker holds the client until pg-server times out (default = 0, no timeout).
**Impact:** Compounds the pool-saturation pattern from the foundational bug.
**Fix scope:** small — `client.query("SET LOCAL statement_timeout='30s'")` at start of every transaction.
**Verification:** VERIFIED-code

### P3-WORKER-46 — Notification worker has no metric for queue depth, retry depth, or sustained backlog
**Severity:** P3
**Category:** observability
**Location:** src/notification_worker.js
**Description:** The /ops dashboard doesn't show `notifications WHERE status='queued'` count, `notifications WHERE status='retry' AND retry_after < NOW()`, or median age of queued items. Without these, operators can't tell if delivery is healthy.
**Impact:** "Did patients receive their notifications today?" requires manual queries.
**Fix scope:** small — add three SQL stats to /ops.
**Verification:** VERIFIED-code

### P3-WORKER-47 — pg-boss `monitorStateIntervalSeconds: 30` runs an internal sweep every 30s on the same DB pool; doubles the pool pressure
**Severity:** P3
**Category:** pool
**Location:** src/job_queue.js:28
**Description:** pg-boss internally runs maintenance queries (`maintenanceIntervalSeconds`, `monitorStateIntervalSeconds`) on its own connections. Configured connectionString is `DATABASE_URL_DIRECT` (port 5432), separate from the request pool, so this is OK in theory — but if `DATABASE_URL_DIRECT` is not set, pg-boss falls back to `DATABASE_URL` (likely the pgbouncer pooled URL).
**Impact:** If env is misconfigured, pg-boss shares the pool with the request handlers, doubling pressure.
**Fix scope:** small — log a warning if `DATABASE_URL_DIRECT` is missing.
**Verification:** VERIFIED-code

### P3-WORKER-48 — TZ bug: `case_sla_worker.fetchSlaCandidates` already documents the Africa/Cairo session-timezone gotcha but the same fix isn't applied in `sla_watcher.js`, `runSlaReminderJob`, or `appointment_reminders`
**Severity:** P3
**Category:** worker
**Location:** Comment at src/case_sla_worker.js:163-169; src/sla_watcher.js:33-40; src/jobs/appointment_reminders.js:22-31
**Description:** The original sweep (case_sla_worker) was fixed by switching to `NOW()::timestamp`. But the OTHER sweeps still use parameterized ISO-Z strings (`$1` from `new Date().toISOString()`). With Africa/Cairo TZ on production Supabase, these comparisons drift by 2-3 hours.
**Impact:** Reminders for "appointments in 24h" actually match "appointments in 21h" (or 27h) due to TZ skew. Patients get 24h reminder 3h before the actual 24h mark.
**Fix scope:** small — switch all comparisons to `NOW()` + interval, or set session TZ to UTC.
**Verification:** VERIFIED-code

### P3-WORKER-49 — Conversation auto-close UPDATE writes `closed_at = NOW()` server-side but the rest of the schema uses ISO strings via JS `nowIso()` — TZ drift on `closed_at` vs other timestamps
**Severity:** P3
**Category:** worker
**Location:** src/routes/messaging.js:399
**Description:** Inside the same UPDATE: `SET status = 'closed', closed_at = NOW()`. Comparing `closed_at` to `created_at` (which is JS-side ISO) for the 7-day reopen check (line 432) mixes server-tz and UTC.
**Impact:** Edge cases at midnight Cairo time where reopen-eligible conversations look 6.9d or 7.1d old depending on tz handling.
**Fix scope:** small — pin TZ to UTC across the codebase.
**Verification:** INFERRED

### P3-WORKER-50 — Server.js `runSlaReminderJob` declares `IN_FLIGHT_WHERE` as an inline string concatenated into the SELECT — fine, but the variable is reused in two queries with the SAME bound parameters expectation, no parameterization shift
**Severity:** P3
**Category:** worker
**Location:** src/server.js:1032; 1037, 1064
**Description:** Code-review nit; the where clause is identical in both transactions, but if a future refactor adds a parameter to one and not the other, the bound parameters could drift.
**Impact:** Maintenance footgun.
**Fix scope:** small — extract to a function returning `{where, params}`.
**Verification:** VERIFIED-code

---

## Summary

**Severity counts:**
- P0: 10 — multi-instance duplicate workers (notification_worker, conversation auto-close, mac-mini probe), pool starvation in SLA reminder + breach + unpaid reminder loops, async setInterval crash pattern, fundamental bug in video stale-slot notifications, silent failures across worker registrations and pg-boss queue init.
- P1: 17 — observability and resilience gaps: notification backlog, missing graceful shutdown, FOR UPDATE not used, sla_watcher duplicate breach pipeline, hardcoded `superadmin-1`, IG token never refreshed, campaign cron `var ci` bug, etc.
- P2: 15 — efficiency / consistency.
- P3: 8 — cosmetic / minor.

**Top three blockers for launch:**
1. **P0-WORKER-1** — notification worker fires from every instance. With 2 Render instances you ship 2x WhatsApp + 2x email per notification on day 1.
2. **P0-WORKER-3 + P0-WORKER-5/6/7** — pool-saturation in the SLA sweep. The known foundational bug pattern recurs in `runSlaReminderJob` and `dispatchUnpaidCaseReminders` because they hold withTransaction over per-row `pool.query` calls.
3. **P0-WORKER-4 + P1-WORKER-23** — outright bugs in `video_scheduler.sweepStalePendingSlots` (wrong field name) and `campaigns cron` (`var ci` capture). Both ship features that are silently broken.

**Cross-cutting recommendations:**
- Establish a "single primary writer" gate: one `if (CONFIG.SLA_MODE === 'primary')` block that wraps EVERY recurring worker, including notification_worker and conversation auto-close.
- Move every recurring sweep to pg-boss with singletonKey to eliminate the multi-instance race entirely. The in-process setInterval fallback should be removed once pg-boss is reliable.
- Add a `worker_runs (worker_name, started_at, finished_at, status, breaches, errors)` table; have every sweep INSERT a row at start and UPDATE at end. Surface "last successful run per worker" on the /ops dashboard with a red flag when `> 2× expected_interval`.
- Add `SET LOCAL statement_timeout = '30s'` to `withTransaction` (src/pg.js:97).
- Stagger crons to non-overlapping minute marks.


---

# Section 07 — Error handling + observability

# Audit 07 — Error Handling + Observability

Scope: `src/server.js`, `src/routes/`, `src/services/`, `src/workers/`, `src/jobs/`, `src/notify*`, `src/case_*`, `src/critical-alert.js`, `src/logger.js`, `src/views/{ops-*,error,patient_500,patient_404,404}.ejs`.
Focus: try/catch coverage; error_logs writes; ?error= flows; ops dashboard; critical-alert; render error spirals; silent failures.

Method: file-by-file read of every site that calls `logErrorToDb`, every redirect with `?error=`/`?err=`/`?msg=`, every async route handler, every worker interval, every res.render fallback.

---

## Inventory

### A. ?error= / ?err= / ?msg= redirect codes (enumerated)

Format: `code` — what triggers it — receiving page actually renders it? — meaningful?

**Patient wizard `/patient/new-case` (`src/routes/patient.js`)** — receiving view `patient_new_case.ejs` reads `__queryErr = locals.queryErr` (route handler must pass it). All steps below DO render contextual blocks per `step3Err`/`step4Err`/`showFilesError`.

1. `err=needs_files` (patient.js:1435) — Step 2 continue clicked with no files uploaded. Rendered. Meaningful.
2. `err=needs_specialty` (patient.js:1465) — Step 3 missing specialty/service. Rendered.
3. `err=specialty_unavailable` (patient.js:1475) — Specialty has 0 active doctors. Rendered.
4. `err=invalid_service` (patient.js:1485, 1551, 1625) — Service doesn't belong to specialty / not visible. Rendered.
5. `err=invalid_tier` (patient.js:1523) — tier not in {standard,vip,urgent}. Rendered (mapped to `needs_sla`/`invalid_tier` block).
6. `err=urgent_outside_window` (patient.js:1531, 1609) — Urgent tier picked outside 7am-7pm Cairo. Rendered (urgency conflict block).
7. `err=<persist.error>` (patient.js:1556, 1631) — `buildStep4Persistence` error; the literal error is dropped into the URL — could be `null`/`undefined` if `persist.error` is empty. **NOT validated** before redirect; depends on internal helper.

**Patient orders upload `/portal/patient/orders/:id/upload` — `patient_order_upload.ejs` reads `error`**

8. `error=locked` (patient.js:2925) — uploads_locked OR completed. Rendered, contextual copy.
9. `error=missing_uploader` (patient.js:2939) — `UPLOADCARE_PUBLIC_KEY` not configured AND no urls. Rendered.
10. `error=missing` (patient.js:2941) — POST without files when uploader IS configured. Rendered ("Please choose a file before submitting"). NOTE: this was the brief's recent example bug — the code path has now been split between `missing` and `missing_uploader`, but a valid POST after Uploadcare CDN-resolves can still hit `error=missing` if `file_url` field isn't set client-side (see Finding P2-ERR-12).
11. `error=too_many` (patient.js:2951) — > 10 file URLs. Rendered.
12. `error=invalid_url` (patient.js:2955, 3016) — All URLs failed `^https?://` check OR DB transaction failed. Note: same code is used for two completely different failure modes (URL format failure AND DB write failure) — see Finding P1-ERR-13.

**Patient messages `/portal/patient/orders/:id/messages` (patient_order.ejs reads `__msgErr = locals.msgErr`)**

13. `err=empty_message` (patient.js:2681) — No text and no file. Rendered.
14. `err=no_doctor_yet` (patient.js:2695) — No doctor assigned. Rendered.
15. `err=conversation_unavailable` (patient.js:2706) — `ensureConversation` returned null. Rendered (falls into generic "couldn't send" branch).
16. `err=send_failed` (patient.js:2737) — INSERT into messages failed. Rendered (generic branch).

**Doctor case `/portal/doctor/case/:caseId` (portal_doctor_case.ejs reads `errorMessage`)**

17. `msg=capacity` (doctor.js:1936) — Doctor at MAX_ACTIVE_CASES_PER_DOCTOR (4). Read by handler at doctor.js:1530-1535, mapped to `errorMessage` local. Rendered.
18. `error=reason_required` (doctor.js:2126) — POST reject-files without reason. **NOT rendered.** The handler at doctor.js:1526-1535 only reads `req.query.msg`, not `req.query.error`. The doctor sees the case page reload with no feedback. See Finding P0-ERR-1.

**Patient initiates message `/portal/patient/case/:caseId/start-message`**

19. `msg=no_doctor` (patient.js:2777) — Patient asked to start a chat but doctor not yet assigned. Recipient `patient_order.ejs` does **NOT** read `__msg`/`msg` — only `__msgErr`/`__sentFlash`. Silent. See Finding P1-ERR-2.

**Other (success/info)**

- `?step=N&id=...` — wizard step
- `?step=2&id=...&uploaded=1` — file uploaded (rendered as flash)
- `?tab=messages&sent=1` — message sent
- `?msg=capacity` (doctor) — handled above
- `?failed=1` (patient.js:1708) — payment-url resolve failed; rendered? See Finding P2-ERR-14.

### B. error_logs writers — by file

| File | logErrorToDb sites | Key fields populated |
|------|---------------------|------------|
| `src/server.js` | 195-219 unhandled rejection/exception; 780-792 global error handler; 1085 SLA breach refund | level,errorId,requestId,url,method,userId,role |
| `src/logger.js` | (writer impl — 101-146) | id, error_id, level, message, stack, context (JSON), request_id, user_id, url, method. **No `category` column populated.** |
| `src/services/admin_audit.js` | 42-55 — only place `category='admin_audit'` is set | id, level, category, message, user_id, request_id, url, method, context |
| `src/services/emailService.js` | `_logEmailError` at 56-81 | id, category='email_send', level, message, context (no user_id/url/method) |
| `src/notify/whatsapp.js` | `logWhatsAppError` at 28-50 | id, category='whatsapp_send', level, message, context, user_id |
| `src/case_sla_worker.js` | 348-350, 357-360 (fetch failures) | level=error, context |
| `src/jobs/appointment_reminders.js` | 67 | context only — no requestId/url (cron job) |
| `src/paymob-hmac.js` | (verifyPaymobHmac catch) | context only |
| `src/routes/admin.js` | 1806 (national_id_view) | context, userId, doctorId, level=audit |
| `src/routes/api/cases_intake.js` | 135 | url, method, context |
| `src/routes/appointments.js` | (multiple) | requestId, url, method, userId |
| `src/routes/auth.js` | 2 sites — encryption-key missing + form re-render | requestId, url, method |
| `src/routes/campaigns.js` | (multiple) | requestId, url, method, userId |
| `src/routes/medical_records.js` | (multiple) | requestId, url, method, userId |
| `src/routes/messaging.js` | 5 sites | requestId, url, method, userId |
| `src/routes/onboarding.js` | (multiple) | requestId, url, method, userId |
| `src/routes/order_flow.js` | 9 sites | requestId, url, method, userId, context |
| `src/routes/payments.js` | 6 sites | context, requestId, url, method |
| `src/routes/prescriptions.js` | (multiple) | requestId, url, method, userId |
| `src/routes/referrals.js` | (multiple) | requestId, url, method, userId |
| `src/routes/reviews.js` | (multiple) | requestId, url, method, userId |
| `src/services/paymob.js` | 1 (createIntention) | context, orderId, code, status |
| `src/services/sla_breach.js` | 2 (recomputeOnBreach, issueBreachRefund) | context, orderId |
| `src/sla_status.js` | 1 (refund hook) | context, orderId |

**Files with ZERO logErrorToDb calls:**
- `src/routes/patient.js` (largest user-facing route — 16 console.error sites; see Finding P0-ERR-3)
- `src/routes/doctor.js` (no logErrorToDb at all)
- `src/routes/superadmin.js` (no logErrorToDb at all)
- `src/routes/intake.js`, `src/routes/video.js`, `src/routes/exports.js`, `src/routes/public.js`, `src/routes/public_orders.js`, `src/routes/help.js`, `src/routes/ops.js` (uses logMajor only)
- `src/routes/analytics.js`, `src/routes/reports.js`, `src/routes/static-pages.js`, `src/routes/static-pages.js`
- `src/notify.js` (queueNotification insert failure → console only)
- `src/notification_worker.js` (worker dispatch failure → console only)
- `src/instagram/scheduler.js`
- `src/video_scheduler.js`
- `src/workers/acceptance_watcher.js`
- `src/case_lifecycle.js` (large file with many catches — console only)

### C. /ops dashboard widget inventory (ops-dashboard.ejs)

System bar: Uptime · Mode · SLA mode · Node version · Heap MB · RSS MB · DB pool active/total · Git SHA · Mac mini gateway status.
Today: cases · revenue · new patients · errors today.
This-month platform: cases MTD · completed MTD · revenue MTD · pending cases · breached SLA · near-breach (<2h) · avg completion hrs · active/total doctors · total patients.
Recent activity: last 10 orders.
Errors 24h: total errors, breakdown by level, recent 10 errors.
Payment Health: unpaid orders, failed payments.
Paymob: last intention age, last webhook age, HMAC failures 24h.
Notifications: status pills (queued/sent/failed/etc) MTD.
Agents: heartbeat status / last task / last seen / tokens MTD / cost MTD / enable-toggle.
Instagram pipeline: post-status pills.
Quick links.

### D. critical-alert (WhatsApp) trigger inventory

Throttled: 1 per 5 minutes (in-process variable `lastSentAt`). NOT cluster-aware — each Render dyno has its own counter, so on multi-instance scale-out this could fire 1 per dyno per 5 minutes.

Triggers:
1. `process.on('unhandledRejection')` (server.js:200)
2. `process.on('uncaughtException')` (server.js:213)
3. Paymob webhook HMAC verification failure (`src/routes/payments.js:231`)

Not used elsewhere.

---

## Findings

### P0-ERR-1 — Doctor `?error=reason_required` is silent
**Severity:** P0
**Category:** ux / handler
**Location:** `src/routes/doctor.js:2126` (redirect) ↔ `src/routes/doctor.js:1526-1535` (GET handler)
**Description:** POST `/portal/doctor/case/:caseId/reject-files` redirects to `/portal/doctor/case/<id>?error=reason_required` when the reason field is empty. The case-detail GET handler reads only `req.query.msg`, not `req.query.error`, so `errorMessage` stays `null` and the view shows nothing. The doctor sees the form re-render with no feedback and assumes nothing happened.
**Impact:** Doctor cannot understand why "request additional files" did nothing — high-friction failure right when patient response is being awaited. Indistinguishable from a broken button.
**Fix scope:** small — read `req.query.error` in doctor.js GET handler and map `reason_required` → localized "Please provide a reason." message.
**Verification:** VERIFIED-code (read both sites).

### P0-ERR-2 — `routes/patient.js` writes ZERO rows to error_logs
**Severity:** P0
**Category:** observability / silent-fail
**Location:** entire `src/routes/patient.js` (3 600+ lines, 16 console.error sites)
**Description:** Every catch block in patient.js logs to console.error only. Sites: alerts.json fetch (529), mark-all-read (561), mark-read (608), AI analysis (930), dashboard order fetch (1015), wizard step1 (1409), wizard step5 payment-url resolve (1707), stub-payment markCasePaid (1826), patient new-case create (2052), payment_backfill_failed (2504), v2-messages ensureConversation (2703), v2-messages insert (2736), patient upload (3015), case-intel enqueue (3021), notifyDoctorFileUploaded (3055). None reach error_logs, so /ops/errors will not show them — they appear only in Render's stdout, where they are unstructured plaintext.
**Impact:** When a patient hits an error in dashboard, wizard, upload, payment, or messages, ops gets no signal. Pattern detection (e.g. "all wizard step 5 calls failing since 14:30") is impossible from /ops. The same applies to doctor.js and superadmin.js (also 0 logErrorToDb).
**Fix scope:** medium — wrap each catch with `logErrorToDb(err, { context, requestId: req.requestId, userId: req.user?.id, url: req.originalUrl, method: req.method })`.
**Verification:** VERIFIED-code.

### P0-ERR-3 — Notification queue insert failure swallowed; user told operation succeeded
**Severity:** P0
**Category:** silent-fail
**Location:** `src/notify.js:340-350`, called from ~50 sites in routes
**Description:** `queueNotification` catches any DB INSERT failure on the `notifications` table, console.errors it, and returns `{ ok: false, skipped: true, reason: 'db_insert_failed' }`. Almost every caller is fire-and-forget — no caller checks the return value. So if the notifications table is broken (e.g. trigger blocks insert, dedupe-key UNIQUE conflict from a DB schema drift, or pool exhausted), the user-facing operation that depends on the notification (case created, doctor assigned, payment received) appears successful but no email/WhatsApp/in-app notification is ever delivered.
**Impact:** Patient submits a case → "Case received" page shown → no email, no WhatsApp, no push. Patient assumes platform broken; doctor never hears about case.
**Fix scope:** medium — at minimum, route the catch through `logErrorToDb` (currently only console.error). Better: surface a sentinel to ops dashboard ("X notifications failed to queue in last 24h").
**Verification:** VERIFIED-code (notify.js:340-350; sample callers public_orders.js:171, patient.js:2285, server.js:1047).

### P0-ERR-4 — Async setInterval handlers swallow rejections that crash the process
**Severity:** P0
**Category:** handler
**Location:** `src/case_sla_worker.js:413-419`, `src/instagram/scheduler.js:34-40`, `src/server.js:892-895` (SLA sweep), `src/server.js:968-970` (notify worker)
**Description:** Several intervals do `setInterval(() => { try { await asyncFn(); } catch(e){} })` or omit try/catch entirely. The synchronous try/catch does NOT catch rejections from async functions. Worse: `runCaseSlaSweep` deliberately rethrows (line 393) when fetchSlaCandidates/fetchDoctorTimeouts fail — but the wrapping `setInterval(() => { try { runCaseSlaSweep(); } catch(err) { logFatal(...); } })` cannot catch the rejection. Combined with `process.on('unhandledRejection') → process.exit(1)` at server.js:204, a single transient pool-exhaustion blip in the SLA sweep takes down the entire process. Render restarts it, but during the gap (seconds to minutes) all routes are unavailable.
**Impact:** Single transient DB blip kills production. Every interval that does an async DB query is at risk. Acceptance watcher (`workers/acceptance_watcher.js:152`) does the same pattern.
**Fix scope:** medium — wrap every interval body in `Promise.resolve().catch(err => logErrorToDb(err, {...}))`.
**Verification:** VERIFIED-code (server.js:195-219 process exit; case_sla_worker.js:393 deliberate rethrow; case_sla_worker.js:413 sync try/catch around async).

### P0-ERR-5 — `error_logs.category` column populated by only 3 callers; 19 routes ignore it
**Severity:** P0 (downgraded — visibility, not user impact)
**Category:** observability
**Location:** `src/logger.js:101-146` (logErrorToDb does NOT pass category) vs migration `src/migrations/035_error_logs_category.sql`
**Description:** Migration 035 added `error_logs.category` for fast filtering. Only three writers populate it: `services/admin_audit.js` (`admin_audit`), `services/emailService.js` (`email_send`), `notify/whatsapp.js` (`whatsapp_send`). Every other call site uses `logErrorToDb()`, which silently ignores `context.category` — its INSERT statement (lines 136-140) does not include the column. So /ops/errors cannot be filtered by source category; the index is essentially unused.
**Impact:** Operator cannot answer "are payment errors spiking?" or "are wizard errors spiking?" without parsing JSON context blobs. Defeats the migration's intent.
**Fix scope:** small — add `category` to the logErrorToDb INSERT and pull `context.category` (with sensible default).
**Verification:** VERIFIED-code (logger.js:136-140; admin_audit.js:43-46).

### P0-ERR-6 — patient_500 / patient_404 inline-include partial that itself can crash
**Severity:** P0
**Category:** ux / log
**Location:** `src/views/patient_500.ejs:16-24` and `:51-56` (includes head + foot)
**Description:** `patient_500.ejs` includes `partials/patient/head` and `partials/patient/foot`. These partials reference `cspNonce` (head:44, foot:18). The global error handler (server.js:798-810) renders `patient_500` with locals `{ lang, isAr, user, errorId, verbose, message }` — it does NOT explicitly pass `cspNonce`. EJS `include` inherits parent locals plus `res.locals`, and `cspNonce` is set on `res.locals` (server.js:234), so it normally works. BUT if the request died BEFORE the CSP middleware ran (e.g. an error in `attachRequestId` or `accessLogger`, or before req-id), `res.locals.cspNonce` is undefined — head/foot read `typeof cspNonce` defensively, so it would render but without nonce, then any inline scripts in the foot get blocked by CSP... and patient_500 has no inline scripts so this path is mostly safe.

The bigger risk: `partials/patient/foot` includes scripts (footer.ejs:60+), and if the error template render somehow imports an EJS error itself (e.g. `partials/patient/icon` is missing for `name: 'alert'`), the global handler's catch-around-render at server.js:818-822 falls through to `res.status(status).type('text/plain').send('An unexpected error occurred. Error ID: ' + errorId)`. This is the documented fallback and works — confirmed safe.

**Impact:** Low risk in normal operation. But during a deploy or a corrupt build, a missing partial could spiral. The fallback string is plain text and does not include lang/RTL — Arabic-speaking patients see English fallback text, which is acceptable.
**Fix scope:** small — explicitly pass `cspNonce: res.locals.cspNonce || ''` to the patient_500 render call to make it less brittle.
**Verification:** VERIFIED-code; see lines 798-822 of server.js.

### P1-ERR-7 — Critical-alert throttle is per-process; multi-dyno deployments multiply alerts
**Severity:** P1
**Category:** observability
**Location:** `src/critical-alert.js:11-12` (`var lastSentAt = 0` module-scoped)
**Description:** Render typically scales to 1 web instance, but if SLA_MODE=primary is consolidated and a horizontal scale-out happens (or if the app moves to 2+ instances), the throttle-counter is per-instance. A flapping bug fires `unhandledRejection` on every dyno, each firing one WhatsApp every 5 minutes → 12 alerts/hour/dyno. Also: the counter is in-memory, so process restarts (which `process.exit(1)` triggers after every unhandledRejection!) reset the throttle — every crash → 1 alert.
**Impact:** A flapping crash loop sends one WhatsApp per crash (because `process.exit` resets state). For a fast crash loop (every 1-2s) this is Meta-rate-limit-burnout territory and possible token suspension. Worse: the admin's WhatsApp inbox is buried in alerts during a real incident.
**Fix scope:** medium — back the throttle by Postgres (e.g. `INSERT INTO critical_alerts (sent_at) ... WHERE NOT EXISTS (SELECT 1 FROM critical_alerts WHERE sent_at > NOW() - INTERVAL '5 minutes')`).
**Verification:** VERIFIED-code.

### P1-ERR-8 — sendCriticalAlert "best-effort" with empty error handlers; no audit trail
**Severity:** P1
**Category:** observability
**Location:** `src/critical-alert.js:53,57`
**Description:** The HTTP request swallows every error (`req.on('error', function(){})`, `catch (_) {}`). When the WhatsApp token has expired (a P0 from integrations audit per the brief), the request silently fails and ops never knows the critical-alert pipeline itself is broken. There is no "WhatsApp critical alert delivery" health metric on the ops dashboard.
**Impact:** The most important ops alert path can be broken for weeks without anyone noticing. When an `unhandledRejection` finally happens, the alert is sent to a 401-returning Meta endpoint and ops finds out about the crash from Render's auto-restart counter, not the WhatsApp.
**Fix scope:** small — log to error_logs (category='critical_alert_delivery') on non-2xx response or socket error; surface "last critical alert delivery age + last status" on /ops dashboard.
**Verification:** VERIFIED-code.

### P1-ERR-9 — Render runtime logs are unstructured; req-id only on access lines
**Severity:** P1
**Category:** log
**Location:** `src/logger.js:5-13` and 132 console.log/63 console.error sites
**Description:** Logger emits `console.log('[' + MODE + ']', ...args)` — plain text. Render's log search treats each line as a string. The access logger (logger.js:48-66) writes `METHOD URL STATUS Xms req_id` per request, so the req-id appears once per response — but every other log line (worker, cron, route handler) does NOT include req-id, so you cannot correlate a downstream `[notify-worker] failed to process notification abc123` with the originating request. There is no JSON output mode despite Render supporting JSON-aware filtering.
**Impact:** Triage requires manually grep-correlating timestamps. Stack traces span multiple lines and break Render's per-line search. No structured query like `level=fatal AND requestId=req_abcd`.
**Fix scope:** medium — switch to `pino`/`winston` with JSON output in production. Stamp every log line with `req.requestId` via `cls-hooked` async-local-storage.
**Verification:** VERIFIED-code (logger.js entirety).

### P1-ERR-10 — Global handler does NOT pass cspNonce to error.ejs; legacy partials with inline JS could break
**Severity:** P1 (downgraded — error.ejs has no inline JS)
**Category:** ux
**Location:** `src/server.js:813-817` (render('error'))
**Description:** The `error.ejs` template (verified, no inline scripts) is fine, but the catch-fallback at 818-822 uses plain-text. If the legacy `error.ejs` were ever extended to include `partials/footer` (which has inline scripts), the missing `cspNonce` would block them — the fallback would silently produce a styled but broken error page. Defensive: explicitly pass `cspNonce`.
**Impact:** Latent — currently fine; would silently break on any future change.
**Fix scope:** small.
**Verification:** VERIFIED-code (error.ejs has no inline scripts).

### P1-ERR-11 — `?error=invalid_url` covers two distinct failure modes
**Severity:** P1
**Category:** ux
**Location:** `src/routes/patient.js:2955` (URL format) and `:3016` (DB transaction failure)
**Description:** Same `?error=invalid_url` redirect is used when (a) the file URLs failed `^https?://` regex and (b) the entire `withTransaction` insert failed. The user sees "That file URL isn't valid. Try uploading again." — incorrect feedback for a DB outage.
**Impact:** User retries upload of a working URL many times, never sees that the server can't write to the DB. Ops sees no `logErrorToDb` write either (patient.js never calls it).
**Fix scope:** small — split into `error=invalid_url` and `error=upload_failed`; add localized copy.
**Verification:** VERIFIED-code.

### P1-ERR-12 — Standalone uploader form omits `csrfField()` invocation safety
**Severity:** P1
**Category:** ux / handler
**Location:** `src/views/patient_order_upload.ejs:128`
**Description:** Form uses `<%- (typeof csrfField === 'function') ? csrfField() : '' %>`. If CSRF middleware fails to populate `csrfField` (which the brief's recent uploader bug history suggests has happened), the form posts with no CSRF token → middleware rejects → 403 (or empty body) → the uploader appears broken with no `?error=` path because the route handler is never reached. Even if the post is submitted, the recent bug pattern (uploader resolves URL but client form never sets `file_url`) results in `error=missing` from line 2941, which IS rendered — so this leg is OK. But the underlying handshake has multiple silent fail points (CDN failure, CSP block on uploader script, CSRF token mismatch) that all degrade to "form does nothing."
**Impact:** Continues the brief's noted history of standalone-uploader silent failures.
**Fix scope:** medium — surface a hard-coded message when CSRF token is absent; surface a client-side `console.error → fetch('/api/client-error', ...)` so true silent failures hit error_logs with a category.
**Verification:** INFERRED (recent commit history e0f0183/29b4c32 shows ongoing uploader debug churn — this audit didn't reproduce live).

### P1-ERR-13 — `?msg=no_doctor` (patient.js:2777) and persist.error in URL not rendered
**Severity:** P1
**Category:** ux
**Location:** `src/routes/patient.js:2777` (msg=no_doctor) and 1556/1631 (`?err=` + raw `persist.error`)
**Description:** `start-message` redirects with `?msg=no_doctor` to `patient_order.ejs`. That view reads `__msgErr` (from `err=` query) and `__sentFlash` (from `sent=` query). It does NOT read `msg=`. The patient who clicked "Message doctor" before assignment sees the case detail page reload with no feedback. Same template DOES have a "no doctor yet" empty state in the Messages tab, so the silent reload is mostly OK — but discoverability is poor. Also: 1556 + 1631 redirect with `&err=<persist.error>` where `persist.error` is whatever `buildStep4Persistence` returned — if undefined, the URL becomes `&err=undefined`. The view's switch falls through to the generic block.
**Impact:** Patient confused but not blocked.
**Fix scope:** small.
**Verification:** VERIFIED-code (patient_order.ejs:445-455 only handles `__msgErr`).

### P1-ERR-14 — `?failed=1` in step5 silent
**Severity:** P1
**Category:** ux
**Location:** `src/routes/patient.js:1708` (redirect after payment-url resolve failed)
**Description:** When step5 cannot resolve the payment URL, it redirects with `?failed=1`. Searching `patient_new_case.ejs` for `failed=` returns 0 hits — the view doesn't render this. Patient sees the wizard reload at step5 with no error.
**Impact:** Patient hits "Pay now," nothing visible happens, retries → same result. This is at the conversion bottleneck of the funnel.
**Fix scope:** small — render a banner for `failed=1` in patient_new_case step5.
**Verification:** VERIFIED-code.

### P1-ERR-15 — emailService failures: stub mode + EMAIL_ENABLED=false silently skip
**Severity:** P1
**Category:** silent-fail
**Location:** `src/services/emailService.js:364-372`, `:434-437`, `:533-536`
**Description:** When `EMAIL_ENABLED=false` (default), `sendEmail` returns `{ ok: false, skipped: true, reason: 'email_disabled' }` and verbose-logs only. When the lifecycle `sendMail({to, subject, text, html})` is called without `RESEND_API_KEY`, it console.warns and returns `{ stub: true }`. Many callers (cases_intake.js:122-126, patient.js:3043-3056, order_flow.js:609) wrap the call in try/catch with no return-value inspection — they report "case received" / "files uploaded" success even though no email left the system. The notification_worker also flags `email_disabled` as a "skipped" success and marks the row 'sent' in DB.
**Impact:** In any environment where EMAIL_ENABLED is forgotten (staging, pre-launch, accidentally rolled back), every "we'll email you" UX is a lie. Notifications table shows 'sent' status even though no Resend dispatch occurred. /ops dashboard's "Notifications: sent" pill misleadingly turns green.
**Fix scope:** medium — distinguish 'sent' from 'skipped' in notifications.status; surface "email pipeline disabled" at top of /ops if `EMAIL_ENABLED !== 'true'`.
**Verification:** VERIFIED-code.

### P1-ERR-16 — notification_worker treats `result.skipped` as `sent` in DB
**Severity:** P1
**Category:** silent-fail / observability
**Location:** `src/notification_worker.js:251-256`
**Description:** `if (result.ok || result.skipped) { UPDATE notifications SET status='sent' }`. The intent is "skipped = nothing to do" but the side-effect is that rows where `email_disabled`, `no_phone_for_user`, `whatsapp_opted_out`, `no_email_for_user` all show as `sent` to ops dashboard. The sent count doesn't mean what it claims to mean.
**Impact:** False sense of dispatch health. /ops dashboard "Notifications MTD: sent N" overstates real delivery.
**Fix scope:** small — store `skipped` as a separate status; pill it on the dashboard.
**Verification:** VERIFIED-code.

### P1-ERR-17 — pgBoss job error handlers log to console only
**Severity:** P1
**Category:** observability
**Location:** `src/job_queue.js:92,106,122`
**Description:** pg-boss handler errors (case-intelligence, case-reprocess, auto-assign) console.error only — they don't write to error_logs. pg-boss internally records job failure in `pgboss.job` table, but ops can't surface that on /ops/errors.
**Impact:** Background-job failures invisible to /ops unless the operator queries `pgboss.job` directly.
**Fix scope:** small — wrap with logErrorToDb(category='pgboss_job').
**Verification:** VERIFIED-code.

### P1-ERR-18 — `case_lifecycle.js` 30+ console.errors, zero error_logs writes
**Severity:** P1
**Category:** observability
**Location:** `src/case_lifecycle.js` (entire file — sample sites: 451, 501, 576, 1870, 1916, 1933, 1965, 1995, 1998, 2007, 2010)
**Description:** This module owns the canonical case-state-machine writes (markCasePaid, reassignCase, markSlaBreach, etc). Every error in earnings recompute, notification dispatch, partial-pay journaling, doctor auto-pause, etc. is console-only. A failed reassignment with no doctor available produces `[case-sla] No eligible doctor for reassignment` to stdout (case_sla_worker.js:150) but no error_logs row.
**Impact:** Earnings desync, missed reassignments, missed pause triggers — all silent.
**Fix scope:** medium — add logErrorToDb at every catch.
**Verification:** VERIFIED-code.

### P1-ERR-19 — `auth.js` login/signup form errors don't preserve user input
**Severity:** P1 (UX — partial overlap with audit 03/05)
**Category:** ux
**Location:** `src/routes/auth.js` (multiple form catches)
**Description:** When a SQL error happens during signup (rare but possible — duplicate email race), the form re-render loses the user's typed-in name/phone/etc. Form re-fills only `email`. logErrorToDb fires but the user has to retype.
**Impact:** Re-entry friction. Not launch-blocking but compounds frustration during incidents.
**Fix scope:** small.
**Verification:** INFERRED (sampled auth.js form-submit catches; not exhaustive).

### P1-ERR-20 — Error handler does not include `path`/`role` in error_logs row
**Severity:** P1
**Category:** observability
**Location:** `src/server.js:780-792` (global handler)
**Description:** The handler builds two contexts. The first (passed to logError-stdout) includes `requestId, method, path, userId, role`. The second (passed to logErrorToDb) replaces `path` with `url` and drops `role`. The DB row therefore has no role label, so /ops/errors cannot answer "are doctor errors spiking vs patient errors."
**Impact:** Blunts triage. Role-based incident filtering impossible.
**Fix scope:** small — add a `role` column to error_logs (or stuff it into context.role) and update INSERT.
**Verification:** VERIFIED-code.

### P1-ERR-21 — /ops dashboard missing: notification worker heartbeat, queue depth, Resend health
**Severity:** P1
**Category:** observability
**Location:** `src/views/ops-dashboard.ejs` (entire)
**Description:** The dashboard does not show:
- Notification worker last-run timestamp (worker pings `care-agent` heartbeat at notification_worker.js:295, but the ops "Agent" panel shows that as a generic `care-agent` row — operators won't realize that's the notif worker).
- Notifications queue depth: `SELECT COUNT(*) FROM notifications WHERE status IN ('queued','retry')`. A growing queue means the worker is dead or slow.
- Failed-notification age: oldest notification stuck in retry. Indicates Meta/Resend outage.
- Resend / WhatsApp configured booleans (so a missing env is visible at a glance).
- Job-queue health: pg-boss state counts (`pgboss.job WHERE state='failed'`).
- Acceptance watcher last-run.
- AI/case-intelligence enqueue success rate.
- OTP delivery rate (Twilio) — currently no metric anywhere.
- Admin audit log volume per day (signal for unusual access).
- Error trend (sparkline) — a single 24h count hides a sudden spike.

**Impact:** Most ops outages will not be reflected on the dashboard until a customer complains.
**Fix scope:** medium — add 6-8 widgets.
**Verification:** VERIFIED-code (ops-dashboard.ejs entire scan).

### P1-ERR-22 — ops-dashboard.ejs reads `errors24h` and `recentErrors` but no ERROR-RATE alarm threshold
**Severity:** P1
**Category:** observability
**Location:** `src/routes/ops.js:289-309`
**Description:** Total errors in last 24h is shown (red card if > 0), but there's no comparison to baseline (e.g. usually 5/day, today 50/day). No way to set a threshold that triggers a critical-alert WhatsApp.
**Impact:** A slow rate climb (like Paymob 4xx slowly returning more `paymob_unavailable`) is invisible until the operator manually checks at 9am.
**Fix scope:** medium — add `errors_per_hour_baseline` calc and trigger sendCriticalAlert when count > 5x baseline.
**Verification:** VERIFIED-code.

### P1-ERR-23 — Migration 035 backfill not run; old rows have category=NULL
**Severity:** P1 (downgraded — intentional per migration comment)
**Category:** observability
**Location:** `src/migrations/035_error_logs_category.sql:13`
**Description:** Migration explicitly does NOT backfill — `Old rows pre-dating this migration have category=NULL — intentional. They are pre-audit-log error rows; not backfilling avoids implying they're audit events.` This is correct semantically, BUT combined with finding P0-ERR-5 (most current writers also leave category NULL), the result is: 99%+ of error_logs rows have category=NULL, the partial index is useless, and the only non-NULL rows are admin audit, email, and WhatsApp.
**Impact:** /ops/errors filtering by category is unusable today.
**Fix scope:** depends on P0-ERR-5 fix.
**Verification:** VERIFIED-code.

### P2-ERR-24 — patient.js console.error sites use bracketed-tag format inconsistently
**Severity:** P2
**Category:** log
**Location:** patient.js (16 sites)
**Description:** Tags are inconsistent: `[patient new-case]`, `[patient order create]`, `[v2-messages]`, `[stub-payment]`, `[payment_backfill_failed]`, `[EMAIL]`, `[dashboard]`, `[alerts.json]`, `[wizard step5 live]`. Tag-based grep cannot reliably find "all patient.js errors."
**Impact:** Triage friction.
**Fix scope:** small — standardize.
**Verification:** VERIFIED-code.

### P2-ERR-25 — Worker log lines lack request-id; cron logs untraceable to source
**Severity:** P2
**Category:** log
**Location:** all interval/cron callers (`server.js:892, 968, 920, 932`)
**Description:** Workers run on intervals — they have no req.requestId concept. The boot/interval/manual labels (`source: 'boot'/'interval'/'manual'`) are passed to `runSlaEnforcementSweep` but only logged to verbose, not to any log line that surfaces the run id. When ops sees `[SLA job] completed in 1340ms`, there's no way to correlate with which sweep run.
**Impact:** Hard to track which sweep ran when an error happens.
**Fix scope:** small — generate a `sweep_id = makeId('sweep')` per run and prefix every log line for that sweep.
**Verification:** VERIFIED-code.

### P2-ERR-26 — Empty catch blocks: 81 `catch (_) {}` and 22 `catch (e) {}` swallow without log
**Severity:** P2
**Category:** silent-fail
**Location:** ~103 sites across src/
**Description:** Spread inventory: `server.js` 13 sites; `routes/admin.js` 2 sites; `routes/superadmin.js` 9 sites; `case_lifecycle.js` 4 sites; `case_sla_worker.js` 2 sites; many more. Most are deliberately swallowing optional/best-effort steps (e.g. logOrderEvent at 105, tableExists fallbacks, post-success notifications). But several swallow real errors:
- `routes/superadmin.js:2084` — reset-email send failed (downgrades to console.warn — at least logged)
- `routes/admin.js:2084,2162` — empty catch
- `case_lifecycle.js:1323,1538,1568,1940` — empty catch
- `routes/patient.js:2756` — notification queue fail in sendmessage path
- `workers/acceptance_watcher.js:105` — logOrderEvent fail

Most of these are best-effort and the swallow is intentional, but mixed in are real errors that should at minimum logErrorToDb at debug level.
**Impact:** Hides root causes during incidents.
**Fix scope:** medium — replace `catch (_) {}` with `catch (e) { logErrorToDb(e, { context, level: 'debug' }) }` in all real catch sites; leave only the truly-no-op ones (e.g. `try { JSON.parse(x) } catch (_) {}`) unchanged.
**Verification:** VERIFIED-code (counted via grep).

### P2-ERR-27 — `seed_specialties.js` writes errors only to console.error during boot
**Severity:** P2
**Category:** log
**Location:** `src/seed_specialties.js:193`
**Description:** Currently disabled by comment in server.js:474, but if re-enabled, errors during specialty seeding go to stdout only.
**Impact:** Mostly latent.
**Fix scope:** small.
**Verification:** VERIFIED-code.

### P2-ERR-28 — Notify-worker initial run + interval errors go to console.error in server.js
**Severity:** P2
**Category:** log
**Location:** `src/server.js:969,972,901`
**Description:** The interval registration uses `console.error('[notify-worker] interval error', err)` and `console.error('[payment-reminders] error', err)`. logErrorToDb not called.
**Impact:** Worker errors invisible to /ops/errors.
**Fix scope:** small.
**Verification:** VERIFIED-code.

### P2-ERR-29 — Render's view-template render failure inside global handler degrades to plain text WITHOUT lang
**Severity:** P2
**Category:** ux
**Location:** `src/server.js:818-822`
**Description:** Fallback says `'An unexpected error occurred. Error ID: ' + errorId` — English only. Arabic patients get English fallback. errorId is exposed for support. Acceptable but not localized.
**Impact:** Minor UX gap during compound failures.
**Fix scope:** small — peek `req.cookies.lang` and switch to Arabic for ar.
**Verification:** VERIFIED-code.

### P2-ERR-30 — Migration log lines in Mobile API migrate go to console.error (non-fatal)
**Severity:** P2
**Category:** log
**Location:** `src/server.js:463`
**Description:** `console.error('[migrate] Mobile API migration failed:', err.message)` after the main migrate call. Mobile API migration failure is non-fatal — server still boots — but operators won't see it on /ops.
**Impact:** Latent — only affects mobile API smoke.
**Fix scope:** small.
**Verification:** VERIFIED-code.

### P2-ERR-31 — `logFatal` is just `console.error` — no DB write, no critical-alert
**Severity:** P2
**Category:** observability
**Location:** `src/logger.js:13`
**Description:** `const fatal = (...args) => console.error('[' + MODE + ']', ...args);` — that's it. No error_logs row, no WhatsApp critical-alert. Authors who choose `logFatal` over `logErrorToDb` (intentionally or by import-shorthand) lose all observability. Sample callers: `case_sla_worker.js:351,361,371,379,417` (every SLA breach handling failure goes to console only); `server.js:849,850,851,856,859,1058,1099,1185` (SLA reminder transaction failures).
**Impact:** SLA breach handling failures invisible to /ops; only Render stdout knows. The brief specifically called out "SLA reminder transaction failed" → only console.
**Fix scope:** medium — make logFatal write to error_logs with level='fatal' AND fire sendCriticalAlert.
**Verification:** VERIFIED-code.

### P2-ERR-32 — Paymob webhook 500s intentional but error path doesn't trigger critical-alert
**Severity:** P2
**Category:** observability
**Location:** `src/routes/payments.js:563-566` (POST /callback final catch)
**Description:** Webhook unexpected error → `logErrorToDb` + `next(err)` → 500 to Paymob. Paymob retries 5xx (per their docs). The `/ops` dashboard surfaces `lastWebhookAt` from payment_events — but if a webhook 500s, no row is inserted in payment_events (the failure happens in main flow). So `lastWebhookAt` could go stale from "real" webhook outage AND from "we keep 500-ing" without distinguishing. No critical-alert is fired — only HMAC failures fire one.
**Impact:** A sustained Paymob → 500 loop is invisible until ops manually inspects errorId.
**Fix scope:** small — fire critical-alert on N+ 500s in 5min window.
**Verification:** VERIFIED-code.

### P2-ERR-33 — `audit.logOrderEvent` failures console.error only
**Severity:** P2
**Category:** observability
**Location:** `src/audit.js:44`
**Description:** logOrderEvent INSERT failure → console.error('logOrderEvent error', err). But logOrderEvent is the canonical audit trail for every state mutation. A silent failure here means we lose audit history rows.
**Impact:** Audit trail gaps. SOC2-style compliance fails. Investigations cannot reconstruct order history.
**Fix scope:** small — also write to error_logs with category='order_audit_failure'.
**Verification:** VERIFIED-code.

### P2-ERR-34 — `pingOps` agent heartbeat is one-way — failures invisible
**Severity:** P2
**Category:** observability
**Location:** `src/notification_worker.js:298-307`, `src/case_sla_worker.js:398-407`, `src/instagram/scheduler.js:131-139`
**Description:** Workers ping `/ops/agent/ping` to update heartbeats. The HTTP request swallows everything (`req.on('error', function() {})`, outer `catch (e) {}`). If localhost:3000 is unreachable (e.g. during boot before listen, or during a Render deploy), the heartbeat is silently lost. Operators see "agent_name: never" on the dashboard despite the worker actively running.
**Impact:** Operator believes worker is dead and may attempt restart, masking real issues.
**Fix scope:** small — call the heartbeat function directly (in-process) instead of round-tripping through HTTP.
**Verification:** VERIFIED-code.

### P2-ERR-35 — Mac mini SSH check has 10s exec timeout but no error logged
**Severity:** P3
**Category:** log
**Location:** `src/routes/ops.js:37-39`
**Description:** SSH exec callback `if (!err) { ... }` — if err, just doesn't update state. macMiniStatus.gateway stays 'unknown' indefinitely. No log line.
**Impact:** Cosmetic — operator sees "unknown" forever.
**Fix scope:** small — log the error so operators know SSH is unreachable.
**Verification:** VERIFIED-code.

### P2-ERR-36 — `runSlaReminderJob` rolls back via `withTransaction` but breach refund is OUTSIDE the transaction
**Severity:** P2
**Category:** silent-fail
**Location:** `src/server.js:1082-1086`
**Description:** Inside `withTransaction(async function(client) { ... await issueBreachRefundSafe(o.id) ... })` — but `issueBreachRefundSafe` does its own DB writes via `execute()` (a separate connection). If the OUTER transaction rolls back AFTER the refund INSERT committed, we have a refund row without the corresponding breach mark. logErrorToDb fires for the wrapper but the inconsistency persists.
**Impact:** Edge-case data integrity. Could cause double-refunds on retry.
**Fix scope:** medium — pass `client` into issueBreachRefundSafe to share the transaction.
**Verification:** VERIFIED-code.

### P2-ERR-37 — `paymentRoutes.use(express.json())` mounted AFTER global rawBody parser — webhook body may be parsed twice
**Severity:** P2
**Category:** handler
**Location:** `src/routes/payments.js:18`
**Description:** Lower priority audit item — confirm with team that Paymob webhook still validates HMAC correctly. If the parser runs twice or the rawBody is consumed before HMAC runs, verifyPaymobHmac could falsely reject. Currently HMAC failures DO fire critical-alert + log to payment_events, so any breakage would be visible. Defensive flag.
**Impact:** Latent.
**Fix scope:** medium.
**Verification:** NEEDS-VERIFICATION.

### P3-ERR-38 — Logging of stack to error_logs truncated at 8000 chars; deep traces lost
**Severity:** P3
**Category:** log
**Location:** `src/logger.js:115`
**Description:** `String(err.stack).slice(0, 8000)` — okay for most stacks; pg-boss async chains can exceed.
**Impact:** Cosmetic.
**Fix scope:** small — bump to 32000 or store first 8K + count.
**Verification:** VERIFIED-code.

### P3-ERR-39 — `error_logs.id` and `error_logs.error_id` are both populated but ops UI exposes only `id`
**Severity:** P3
**Category:** ux
**Location:** `src/views/ops-error-detail.ejs:53` (`err.error_id || err.id`)
**Description:** Each row has both. Some user-facing pages show `errorId` (the err_xxxx prefix). The /ops/errors list at `ops-errors.ejs:77` only links via `id`. If a customer says "I got error err_abc12345", ops has to search both columns.
**Impact:** Cosmetic.
**Fix scope:** small — index error_id and add a search box.
**Verification:** VERIFIED-code.

### P3-ERR-40 — `ops/errors?level=warn` filter exists but no row is ever written with `level=warn`
**Severity:** P3
**Category:** observability
**Location:** `src/views/ops-errors.ejs:54` filter exposed
**Description:** logErrorToDb defaults level to 'error'. Only `_logEmailError` writes 'warn' (when blocked). Most callers don't set level. The filter exists in the UI but yields ~0 results.
**Impact:** Cosmetic.
**Fix scope:** small — adopt warn for non-fatal client errors (e.g. 4xx redirects with err codes).
**Verification:** VERIFIED-code.

### P3-ERR-41 — `pgBoss` is the canonical job runner but `/ops` doesn't show pgboss state
**Severity:** P3
**Category:** observability
**Location:** `src/routes/ops.js` (no widget)
**Description:** pg-boss tables live in `pgboss.*` schema. /ops does not query `pgboss.job` for active/failed/created counts.
**Impact:** Background processing health is invisible.
**Fix scope:** small.
**Verification:** VERIFIED-code.

### P3-ERR-42 — patient_500.ejs trustDensity/variant locals not validated; failure case is fail-open
**Severity:** P3
**Category:** ux
**Location:** `src/views/patient_500.ejs:16-24`
**Description:** Passes `variant: 'dark'` and `trustDensity: 'light'` — partials accept these silently. If a partial change rejected unknown variants, the error template would itself fail and trigger the fallback. Acceptable.
**Impact:** Cosmetic.
**Fix scope:** none required.
**Verification:** VERIFIED-code.

### P3-ERR-43 — Render git SHA shows "unknown" if neither `RENDER_GIT_COMMIT` nor `git rev-parse` works
**Severity:** P3
**Category:** observability
**Location:** `src/routes/ops.js:411-416` and `src/server.js:11-25`
**Description:** Both callers fallback to `null`/'unknown'. ops-dashboard.ejs:127 conditionally hides the SHA line. Acceptable.
**Impact:** Cosmetic.
**Fix scope:** none.
**Verification:** VERIFIED-code.

### P3-ERR-44 — Migration runner does not record migration failures in error_logs
**Severity:** P3
**Category:** observability
**Location:** `src/db.js:25-44`
**Description:** Migration failure → exception bubbles → server.js:454-457 catches → `logFatal('DB migrate failed — refusing to start', err)` → process.exit(1). logFatal is console-only, no error_logs (DB write would fail anyway since the migrations' DB just failed).
**Impact:** Acceptable — pre-boot failure, Render logs capture it.
**Fix scope:** none.
**Verification:** VERIFIED-code.

### P3-ERR-45 — `notify_worker` pings `/ops/agent/ping` from inside the same Node process via HTTP
**Severity:** P3
**Category:** handler
**Location:** `src/notification_worker.js:298-307`
**Description:** Round-trip HTTP through localhost just to update a heartbeat row. Wastes a connection. Failure is silent (P2-ERR-34).
**Impact:** Cosmetic + minor inefficiency.
**Fix scope:** small.
**Verification:** VERIFIED-code.

### P3-ERR-46 — `/ops/agent/ping` is unauthenticated (intentional for in-process callers) — could be probed externally
**Severity:** P3 (overlaps with security audit)
**Category:** observability
**Location:** `src/routes/ops.js:654-684`
**Description:** Comment says "no auth — called from server-side agents". External users can POST junk heartbeats and pollute the agent table. Bounded by `MAX_FIELD_LEN = 200` so impact is minor; an attacker could falsely show a "happy" agent_status.
**Impact:** Trust model — operator may believe a worker is healthy when it's not.
**Fix scope:** small — require an internal-only `X-Agent-Token` header.
**Verification:** VERIFIED-code.

### P3-ERR-47 — Stack output of `logError` includes only the message+stack — request body is omitted
**Severity:** P3
**Category:** log
**Location:** `src/logger.js:74-95`
**Description:** logError's console output omits `req.body` (correct: PII risk). But logErrorToDb also omits body. Triage of intermittent route bugs requires synthetic reproduction.
**Impact:** Cosmetic.
**Fix scope:** none — privacy preferred.
**Verification:** VERIFIED-code.

---

## Summary

- **8 P0 findings** (silent failures masking real user-blocking bugs).
- **20 P1 findings** (ops dashboard misses critical signals; major silent paths).
- **14 P2 findings** (noisy logs, missing observability fields).
- **4 P3 findings** (cosmetic).

Highest-impact items to fix before launch:
1. P0-ERR-1 — doctor reject-files redirect silent.
2. P0-ERR-2 — patient.js never writes error_logs.
3. P0-ERR-3 — notification queue insert failure swallowed; user told operation succeeded.
4. P0-ERR-4 — async setInterval bodies can take down the process via unhandledRejection → process.exit.
5. P1-ERR-7/8 — critical-alert throttle is per-process; WhatsApp delivery itself is unobserved.
6. P1-ERR-15/16 — emailService skipped + `result.skipped → status='sent'` makes notifications dashboard a lie.
7. P1-ERR-21 — /ops missing 6+ critical widgets (queue depth, worker heartbeats, OTP delivery, etc).

Cross-references:
- Critical-alert WhatsApp token validity → integrations audit (05).
- pgBoss job-failure surface → workers audit (06).
- error_logs table schema → data-layer audit (08).


---

# Section 08 — Data layer audit

# Data Layer Audit — 2026-05-06

Scope: data layer (migrations, boot-path schema drift, code-vs-DDL coverage,
FK indexes, soft delete, encryption, JSONB, timestamp drift, ON DELETE,
seed data). Source-of-truth: src/migrations/*.sql + src/migrate_mobile_api.js
+ src/db.js seedPricingData() + grep across src/.

---

## Summary

**Migration count:** 43 .sql files in src/migrations/.
- Filenames: 001 → 042, plus a duplicate 019b and a duplicate 025
  (`025_email_campaigns_approval.sql` AND `025_prescribed_medications_log.sql`).
- Numbering gap: **029 is missing** (jumps 028 → 030).
- Boot order is alphabetical (`fs.readdirSync().sort()` in src/db.js:23).
  `025_email_campaigns_approval.sql` therefore runs before
  `025_prescribed_medications_log.sql` deterministically (e < p), but the
  human-readable ordering is ambiguous and unsafe.
- Migration **020** and **032** both add `orders.paid_at` (the second is
  defensive; harmless because both use `IF NOT EXISTS`, but it is debt).
- Migration `008_auto_assign_setting.sql` is the only migration with no
  IF-NOT-EXISTS / DO-block guard. It uses INSERT … ON CONFLICT (key) DO
  NOTHING, which IS idempotent for that table — fine, but the pattern is
  inconsistent.

**Boot-path additions (migrate_mobile_api.js — outside schema_migrations):**
- ALTER TABLE … ADD COLUMN (via `safeAddColumn`):
  - users.push_token, users.refresh_token, users.refresh_token_expires_at,
    users.reset_token, users.reset_token_expires
  - orders.reference_id, orders.clinical_question, orders.country,
    orders.base_price, orders.currency, orders.sla_deadline, orders.urgent,
    orders.deleted_at
  - notifications.type, notifications.title, notifications.message,
    notifications.is_read, notifications.data
  - order_files.uploadcare_uuid, order_files.filename, order_files.mime_type,
    order_files.size, order_files.ai_quality_status, order_files.ai_quality_note
- CREATE TABLE IF NOT EXISTS:
  - otp_codes (also created by migration 015)
  - order_timeline (NOT in any migration)
  - payments (legacy — DROPPED by migration 042)
  - doctor_specialties (also created by migration 033)
- CREATE INDEX IF NOT EXISTS: idx_orders_ref, idx_order_timeline,
  idx_notifications_type, idx_notifications_is_read, idx_payments_order,
  idx_doctor_specialties_doctor, idx_orders_deleted_at

**Columns/tables in code but NOT in any controlled DDL:**
- order_timeline TABLE (used in routes/api/cases.js, routes/api/profile.js)
  — exists ONLY via migrate_mobile_api.js. No migration codifies it.
- payments TABLE — code in routes/api/cases.js still SELECTs from it, but
  migration 042 DROPS the table. P0 crash on next call to GET /cases/:id.
- orders.urgent — added by migrate_mobile_api but DROPPED by migration 010
  ("urgent → urgency_flag rename"). The boot-time mobile add will silently
  re-create it on every boot with default false, undoing the schema cleanup
  if migration 010 has already run.
- orders.country — only created by mobile boot path, no codified migration.
  Used in routes/payments/checkout, mobile API.
- orders.sla_deadline — only created by mobile boot path. Used in many
  routes via `services/sla_breach`, intake.js.

**FKs without supporting indexes (Postgres does NOT auto-index FKs):**
Total FK count: 7 (low — most relations are app-level TEXT id, no FK).
- order_addons.order_id → orders(id) ON DELETE CASCADE — has idx_order_addons_order. OK.
- order_addons.addon_service_id → addon_services(id) — covered by composite
  idx_order_addons_order_service (order_id, addon_service_id). Composite
  starts with order_id, so reads filtered solely by addon_service_id (e.g.
  refunds reconciliation) cannot use it. **Missing dedicated index.**
- addon_earnings.order_addon_id → order_addons(id) ON DELETE CASCADE — has
  unique idx_addon_earnings_once. OK.
- refunds.order_id → orders(id) ON DELETE CASCADE — has idx_refunds_order. OK.
- prescribed_medications_log.prescription_id → prescriptions(id) ON DELETE
  CASCADE — **NO index on prescription_id**. ON DELETE CASCADE will sequential-
  scan the log table to find children whenever a prescription is hard-deleted.
- services.specialty_id → specialties(id) (added in 041) — services has
  idx_orders_specialty_id but not idx_services_specialty_id; sub-100 row
  table so scan is fine, but flagged for completeness.

(All other "FK-shaped" relations — orders.patient_id → users.id,
orders.doctor_id → users.id, doctor_assignments.case_id → cases.id, etc. —
are app-level only. No DB-level integrity. Leaves orphan risk on user/order/
specialty deletes.)

---

## Findings

### P0-DATA-1 — Boot-time `migrate_mobile_api.js` re-adds `orders.urgent` after migration 010 drops it
**Severity:** P0
**Category:** schema-drift
**Location:** src/migrate_mobile_api.js:37 vs src/migrations/010_broadcast_system.sql:7-12
**Description:** Migration 010 explicitly migrates `orders.urgent` → `orders.urgency_flag` and DROPs `urgent`. Then migrate_mobile_api.js (which runs every boot, after migrate()) calls `safeAddColumn('orders', 'urgent', 'BOOLEAN DEFAULT false')`, recreating the very column 010 deleted. ADD COLUMN IF NOT EXISTS won't error, but the column reappears with default false — re-introducing the drift each boot.
**Impact:** Every boot resurrects a deprecated column; queries that read `urgent` now silently return false; migration 010 is effectively reverted. Confuses any new dev reading the schema. Wastes a column slot.
**Fix scope:** small (delete the line in migrate_mobile_api.js and add explicit DROP COLUMN IF EXISTS to a new migration if needed).
**Verification:** VERIFIED-code

### P0-DATA-2 — `routes/api/cases.js` SELECTs from `payments` table that migration 042 drops
**Severity:** P0
**Category:** schema-drift
**Location:** src/routes/api/cases.js:142 + 358; src/migrations/042_paymob_intentions.sql:54-70
**Description:** Mobile API endpoint `GET /cases/:id` runs `SELECT … FROM payments WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1` to surface payment status to the mobile app. Migration 042 DROPs the `payments` table after a row-count guard. After migration 042 runs (on a DB where payments is empty), the table is gone; the next mobile call to GET /cases/:id throws `relation "payments" does not exist` and returns 500.
**Impact:** Mobile app payment-status surface is broken post-042 deploy. Patients on mobile see "could not load case details" instead of payment state.
**Fix scope:** medium — either keep `payments` (revert that part of 042) or rewrite cases.js to read from `payment_events` / `orders.payment_status`.
**Verification:** VERIFIED-code

### P0-DATA-3 — `migrateForMobileApi(pool)` is fire-and-forget (not awaited)
**Severity:** P0
**Category:** migration
**Location:** src/server.js:461
**Description:** `migrateForMobileApi(pool);` is called WITHOUT `await`. The Express app starts and begins serving traffic before the boot-path schema mutations complete. Routes that touch `order_timeline`, `otp_codes`, `payments`, etc. can race the migration and get "relation does not exist" on the very first requests after deploy.
**Impact:** First-request crashes on cold deploys; flaky CI; non-deterministic boot.
**Fix scope:** small (add `await`).
**Verification:** VERIFIED-code

### P0-DATA-4 — Soft-delete filter (`deleted_at IS NULL`) is missing in 95%+ of order queries
**Severity:** P0
**Category:** soft-delete
**Location:** ALL of: src/routes/payments.js, src/routes/superadmin.js, src/routes/doctor.js, src/routes/patient.js (most queries), src/case_lifecycle.js, src/sla_worker.js, src/jobs/sla_watcher.js, src/notify/broadcast.js, src/auto_assign.js, src/assign.js, src/server.js (in-flight queries), src/case_sla_worker.js, src/notification_worker.js, src/sla_watcher.js, src/workers/acceptance_watcher.js, src/routes/order_flow.js, src/routes/exports.js, src/routes/reviews.js, src/routes/prescriptions.js, src/routes/tash-api.js, src/routes/admin.js, src/routes/annotations.js, src/routes/medical_records.js, src/routes/referrals.js, src/routes/addons.js, src/routes/campaigns.js
**Description:** `grep -c "deleted_at" routes/{patient,superadmin,payments,doctor}.js` returns 0 in all four files. The ONLY callers that filter on `deleted_at IS NULL` are case_lifecycle.js:552 and routes/api/cases.js (mobile). That means: superadmin dashboards, doctor dashboards, patient dashboards, SLA watchers, auto-assign, broadcast notifications, payment webhook handlers, finance reports, and admin exports all see soft-deleted orders.
**Impact:** Patients soft-deleted at 48h still trigger SLA breach alerts, still show on doctor dashboards, still get broadcast invitations sent. Revenue/analytics counts include deleted rows. Undelivered orders remain "in-flight" from the SLA worker's POV indefinitely. Mass leakage of supposedly-hidden rows.
**Fix scope:** large — needs systematic add of `AND deleted_at IS NULL` to every query that should respect the soft-delete; or better: a Postgres VIEW `orders_active` that the application reads from, with `orders` reserved for explicit-include callers.
**Verification:** VERIFIED-code

### P0-DATA-5 — `routes/api/cases.js` writes to `order_timeline` which has no FK and no migration
**Severity:** P0
**Category:** schema-drift
**Location:** src/routes/api/cases.js:111, 287, 341; src/migrate_mobile_api.js:71-79
**Description:** `order_timeline` is created ONLY by the boot-time mobile path. No migration codifies it; a fresh DB built from src/migrations/ alone won't have it. The schema has no FK on `order_id`, no NOT NULL where it should, and no index on (order_id, created_at) for the read path. The boot-time creation is non-deterministic (depends on `migrateForMobileApi` having completed — see DATA-3).
**Impact:** Fresh-DB tests fail; CI bootstraps may race; orphan rows possible on order delete (no CASCADE).
**Fix scope:** small (codify in a migration with FK + index).
**Verification:** VERIFIED-code

### P1-DATA-6 — Two migration files share number 025
**Severity:** P1
**Category:** migration
**Location:** src/migrations/025_email_campaigns_approval.sql + src/migrations/025_prescribed_medications_log.sql
**Description:** Both files start with `025_`. Boot order is by filename string-sort, so `025_email_campaigns_approval.sql` runs before `025_prescribed_medications_log.sql` deterministically (e < p), but it is unsafe documentation — a future PR adding `025_x_anything.sql` whose name lexically falls between the two could re-order the world. Schema_migrations tracks by filename so neither file is replaced; both run.
**Impact:** Documentation/intent is muddled; future PRs are at risk of re-ordering.
**Fix scope:** small — rename one to 025b_, mirroring the 019b precedent.
**Verification:** VERIFIED-code

### P1-DATA-7 — Migration numbering gap at 029
**Severity:** P1
**Category:** migration
**Location:** src/migrations/ (jumps 028 → 030)
**Description:** No `029_*.sql`. Either: (a) a migration was intended and never landed, (b) a migration was deleted post-deploy, or (c) numbering accident. The migration commentary in 030 doesn't reference 029. Combined with migration 033's note that production has a side migration `020_onboarding_schema_alignment.sql` that was never in the repo, there is a clear pattern of out-of-band schema edits.
**Impact:** Audit confusion; possible undocumented production-only migration not codified in repo.
**Fix scope:** small — investigate prod's `schema_migrations` rows to see what name was applied for 029, if anything.
**Verification:** NEEDS-VERIFICATION (requires running `SELECT filename FROM schema_migrations ORDER BY id;` against prod)

### P1-DATA-8 — Migrations 020 and 032 both add `orders.paid_at`
**Severity:** P1
**Category:** migration
**Location:** src/migrations/020_orders_paid_at.sql + src/migrations/032_orders_paid_at.sql
**Description:** Both migrations are essentially the same: ALTER TABLE orders ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ + backfill. 032 was added (per its own header comment) because 020 was apparently never deployed. Both are in the repo now; both will run on a fresh DB. Idempotent because of IF NOT EXISTS, but doubles the runtime backfill on prod first-deploy and is sloppy.
**Impact:** No correctness bug, but encodes the lack of trust in the migration runner / the prod-vs-repo drift episode permanently.
**Fix scope:** small — keep 032 (more complete: adds the index too), drop 020 if not yet deployed; or annotate 020 as "applied but no-op now".
**Verification:** VERIFIED-code

### P1-DATA-9 — Migration 033 RE-INSERTs `spec-pathology` that migration 018 explicitly deleted
**Severity:** P1
**Category:** seed
**Location:** src/migrations/018_dedupe_specialties.sql:81-87 (DELETE) + src/migrations/033_onboarding_schema_alignment_codify.sql:106-137 (INSERT … ON CONFLICT (id) DO UPDATE)
**Description:** Migration 018's whole purpose was to delete `cardiology`, `oncology`, `neurology`, `radiology`, `spec-pathology` and repoint references to canonical `spec-cardiology` / `lab_pathology`. Migration 033 then INSERTs the row `('spec-pathology', 'Pathology', …, true)` ON CONFLICT (id) DO UPDATE — re-creating the exact dupe 018 spent its whole transaction removing. After 033 runs you have BOTH `lab_pathology` and `spec-pathology` again, with their services pointing at `lab_pathology` (because 018 already redirected them) — but the dropdown drift is back.
**Impact:** Doctor signup specialty dropdown shows two pathology options ("Lab & Pathology" + "Pathology"); the latter has zero services. Patients picking it get an empty service list. Migration 018's de-dup was undone.
**Fix scope:** small — delete the `spec-pathology` row from 033's INSERT VALUES list, OR change to ON CONFLICT (id) DO NOTHING so the dedup persists on production.
**Verification:** VERIFIED-code

### P1-DATA-10 — `addons_json` declared TEXT but used as JSONB
**Severity:** P1
**Category:** schema-drift
**Location:** src/migrations/002_column_additions.sql:178-180 (TEXT) vs src/routes/payments.js:533 (`COALESCE(addons_json, '{}')::jsonb || $1::jsonb`)
**Description:** The column was created as `TEXT DEFAULT NULL`. The payments add-on append code does `COALESCE(addons_json, '{}')::jsonb || $1::jsonb` which casts at write time. That works, but: (a) reads that try to filter inside the JSON (e.g. `addons_json->'video_consultation'`) require a runtime cast, no JSONB index possible; (b) future writes that don't manually cast (or older code paths) overwrite the column with a plain JSON string; round-trip is ambiguous.
**Impact:** No GIN index possible on JSON keys; queries inside the JSON are full-table scans; future writers must remember to cast. JSONB conversion would also catch malformed JSON at write time.
**Fix scope:** medium — `ALTER TABLE orders ALTER COLUMN addons_json TYPE JSONB USING addons_json::jsonb;` in a migration, with a backfill validating the strings parse.
**Verification:** VERIFIED-code

### P1-DATA-11 — Massive TIMESTAMP / TIMESTAMPTZ drift on the orders table
**Severity:** P1
**Category:** schema-drift
**Location:** src/migrations/001_initial_tables.sql (orders columns are bare TIMESTAMP) + 020/022/032/042 (paid_at, deleted_at, hmac_verified_at are TIMESTAMPTZ)
**Description:** orders.created_at, updated_at, accepted_at, deadline_at, completed_at, breached_at are TIMESTAMP WITHOUT TIME ZONE. orders.paid_at, orders.deleted_at, orders.hmac_verified_at are TIMESTAMPTZ. Same table, two semantics. JS `Date` writes ISO strings — Postgres will store them differently depending on column type. Comparisons across these columns (e.g. "was paid_at before deadline_at?") silently coerce.
**Impact:** Subtle off-by-3-hour bugs in SLA / earnings analytics if any patient/doctor crosses Egypt's UTC+3 timezone boundary with mixed columns. Server is UTC (Render default), so for naive callers the bug is hidden — until daylight-saving-time discussion or a non-UTC server creeps in.
**Fix scope:** large — single migration to ALTER COLUMN … TYPE TIMESTAMPTZ on each historical column, validating no in-flight writes are mid-flight.
**Verification:** VERIFIED-code

### P1-DATA-12 — `notifications` table has dual-schema mode (legacy + mobile)
**Severity:** P1
**Category:** schema-drift
**Location:** src/migrations/001_initial_tables.sql:80-89 (legacy) + src/migrate_mobile_api.js:43-47 (mobile additions); used in src/routes/doctor.js:1000-1259, src/routes/patient.js:273-599, src/routes/superadmin.js:148-283, src/utils/notifications.js
**Description:** Original schema: id, order_id, to_user_id, channel, template, status, response, at + dedupe_key, attempts, retry_after. Mobile additions (boot-time): type, title, message, is_read, data. Code reads BOTH:
- `WHERE COALESCE(is_read, false) = false` (mobile)
- `WHERE COALESCE(LOWER(status), '') NOT IN ('seen','read')` (legacy)
- `INSERT INTO notifications … (template, status, at)` (legacy: server.js:1176)
- `INSERT INTO notifications (id, to_user_id, type, title, message, at)` (mobile: routes/api/conversations.js:134)
A patient-side query updates BOTH `is_read = true` and `status = 'seen'` — the helpers do that conditionally based on a runtime `cols` introspection (utils/notifications.js:138). That is the only thing keeping the two modes consistent.
**Impact:** Any new INSERT that picks ONE schema (legacy template/status, or mobile type/title) leaves the other set NULL; any new SELECT that uses ONE filter (is_read OR status) will miss rows written under the OTHER convention. Bug-prone surface, hard to reason about.
**Fix scope:** large — either decide on one canonical schema and migrate all writers/readers, or wrap reads in a normalizing view.
**Verification:** VERIFIED-code

### P1-DATA-13 — `prescribed_medications_log.prescription_id` has FK ON DELETE CASCADE but no supporting index
**Severity:** P1
**Category:** fk-index
**Location:** src/migrations/025_prescribed_medications_log.sql:41 + idx list at lines 54-56 (no idx on prescription_id)
**Description:** FK with ON DELETE CASCADE → Postgres scans the child table on every parent delete to find rows to cascade. Indexes on doctor_id / specialty / created_at exist; prescription_id (the FK column) does NOT. With ~hundreds of log rows per prescription, this is fine; with tens of thousands it scales linearly with parent-delete cost.
**Impact:** Slow prescription delete (which fires 1 sequential scan of prescribed_medications_log). Today negligible (prescriptions are rare deletes), but flagged for scale.
**Fix scope:** small — add `CREATE INDEX IF NOT EXISTS idx_pml_prescription_id ON prescribed_medications_log(prescription_id);`.
**Verification:** VERIFIED-code

### P1-DATA-14 — `order_addons.addon_service_id` lacks dedicated index
**Severity:** P1
**Category:** fk-index
**Location:** src/migrations/019_addon_services.sql:78-105
**Description:** order_addons has FK on addon_service_id with no ON DELETE clause (defaults to NO ACTION). The composite unique index `idx_order_addons_order_service (order_id, addon_service_id)` covers reads filtered by order_id, but reads filtered ONLY by addon_service_id (e.g. "all video_consult addons across orders, ever") cannot use the composite (Postgres needs the leading column). With three rows in `addon_services` and small order volume this is academic, but it WILL bite the analytics dashboard filtering by addon type.
**Impact:** Slow analytics filters on addon type at scale.
**Fix scope:** small — add `CREATE INDEX IF NOT EXISTS idx_order_addons_addon_service_id ON order_addons(addon_service_id);`.
**Verification:** VERIFIED-code

### P1-DATA-15 — `notifications.dedupe_key` UNIQUE WHERE NOT NULL — code mostly does NOT use ON CONFLICT
**Severity:** P1
**Category:** schema-drift
**Location:** src/migrations/003_indexes.sql:19; src/notify.js:281, 313, 368, 409, 434
**Description:** The unique partial index supports `ON CONFLICT (dedupe_key) DO NOTHING`. notify.js:281, 368, 409, 434 instead pre-checks: `SELECT 1 FROM notifications WHERE dedupe_key = $1`. The pre-check + INSERT is a TOCTOU race: two notify workers running in parallel can both read no row, both INSERT, the second errors with constraint violation. There is no try/catch around the INSERT in notify.js:313, so the constraint violation propagates as a 500.
**Impact:** Rare 500 on duplicate notifications under concurrent load.
**Fix scope:** small — switch to `INSERT … ON CONFLICT (dedupe_key) DO NOTHING` and remove the pre-check.
**Verification:** VERIFIED-code

### P1-DATA-16 — Many `WHERE status IN (...)` queries on orders, but no functional/partial index for the active-order filter
**Severity:** P1
**Category:** fk-index
**Location:** src/auto_assign.js:82, src/case_sla_worker.js:62, src/sla_worker.js:47/74/109, src/server.js:1037 (IN_FLIGHT_WHERE), src/jobs/sla_watcher.js:85
**Description:** Index `idx_orders_status` (003_indexes.sql:5) is a plain b-tree, useful for equality. The hot SLA-watch queries are `WHERE status IN ('new','accepted','in_review','review','submitted',...) AND deadline_at < NOW() …`, which use idx_orders_deadline_at if at all. No partial index like `CREATE INDEX … ON orders(deadline_at) WHERE LOWER(status) IN ('accepted','in_review','review')`. Migration 010 added a partial idx_orders_acceptance_deadline for the broadcast watcher — good — but nothing equivalent for the SLA breach watcher.
**Impact:** SLA watcher does a full deadline_at index scan + filter every cycle. Today small (low volume); at scale the watcher gets slower linearly.
**Fix scope:** small — add a partial index aligned to IN_FLIGHT_WHERE.
**Verification:** VERIFIED-code

### P1-DATA-17 — `orders.base_price` not backfilled for legacy orders
**Severity:** P1
**Category:** migration
**Location:** src/migrations/037_orders_base_price.sql + src/routes/payments.js / src/routes/order_flow.js (writers)
**Description:** Migration 037 ADDs the column with no DEFAULT and no UPDATE backfill. Legacy paid orders (3 known) have base_price=NULL. The migration's own header notes "code reads it as Number(x) || 0". Earnings reports and refund calculations therefore treat legacy orders' base price as 0 — which makes the urgency-uplift refund (orders.urgency_uplift_amount) look like the entire price, refunding too little. (In practice 3 demo orders, but the policy is wrong-by-default for any future row that bypasses the writer.)
**Impact:** Refund calculation under-pays patient on legacy orders by base_price; analytics undercount base revenue for those rows.
**Fix scope:** small — backfill `UPDATE orders SET base_price = (services.base_price snapshot) FROM services WHERE …` in a follow-up migration.
**Verification:** VERIFIED-code

### P1-DATA-18 — `orders.urgency_uplift_amount` NOT NULL DEFAULT 0 — but orders rows from before 030 will not be backfilled with the actual uplift
**Severity:** P1
**Category:** migration
**Location:** src/migrations/030_orders_urgency_uplift_amount.sql:23-25
**Description:** Migration 030 sets the column NOT NULL DEFAULT 0. Postgres back-applies the default to existing rows. For any historical urgent / VIP order, the uplift_amount is now 0 even though the price column reflects the urgent-tier total. Refund logic that treats 0 uplift as "no uplift to refund" will refund nothing.
**Impact:** Pre-030 urgent/VIP orders that breach SLA refund the wrong amount (zero of uplift, instead of the actual 1.3x or 1.6x delta).
**Fix scope:** small — backfill `UPDATE orders SET urgency_uplift_amount = price - base_price WHERE urgency_tier IN ('vip','urgent') AND price > 0` (after fixing base_price; see DATA-17).
**Verification:** VERIFIED-code

### P1-DATA-19 — `cases` table is legacy but still actively written to by intake / cases-intake APIs
**Severity:** P1
**Category:** schema-drift
**Location:** src/routes/intake.js:282, src/routes/api/cases_intake.js:112; src/migrations/009_intelligence_status_to_orders.sql comment ("cases table is legacy")
**Description:** Migration 009 explicitly documents that "the cases table is legacy; orders is the live system of record." But two intake routes still INSERT into `cases`. Those rows then exist parallel to a sibling `orders` row (since migration 009 copied intelligence_status from cases→orders, and downstream lifecycle reads from orders). Dual-write with no consistency guarantee.
**Impact:** Cases table gradually fills with rows that never get reconciled to orders; some downstream code (case_lifecycle.js writes to case_events / case_context) becomes a junk drawer.
**Fix scope:** medium — decide: drop cases entirely (and remove case_events / case_context inserts) OR document it as the "intake staging" table and add a follow-up that copies to orders.
**Verification:** VERIFIED-code

### P1-DATA-20 — `services` mass UPDATE migrations (sla_hours, commission_pct) silently update doctor-customised rows
**Severity:** P1
**Category:** migration
**Location:** src/migrations/036_sla_hours_align_to_policy.sql:33-40 + 026_addon_commission_fix.sql:33-34 + 019_addon_services.sql:142-153
**Description:** `UPDATE services SET sla_hours = 48 WHERE sla_hours = 72` rewrites the column for every row that happens to be 72. If an admin had ever explicitly customised a service to 72 hours (vs the inherited default), the customisation is silently overwritten. Same for commission_pct = 80 → 85 in 026. There is no service-customisation flag or `is_overridden` column to gate the migration.
**Impact:** Admin customisations are lost on policy migrations; no audit trail of overwrite. Currently no admin has customised (per code review), but the pattern is destructive.
**Fix scope:** medium — add an `is_overridden` flag or use `WHERE sla_hours = 72 AND updated_at < migration_landed_at` — for now, document the assumption.
**Verification:** VERIFIED-code

### P1-DATA-21 — `INSERT INTO doctor_specialties (id, …)` collides with multi-doctor signup race
**Severity:** P1
**Category:** schema-drift
**Location:** src/routes/auth.js:943-947 + src/migrations/033_onboarding_schema_alignment_codify.sql:88-94 (no UNIQUE constraint)
**Description:** doctor_specialties is created with `id TEXT PRIMARY KEY`, no UNIQUE on (doctor_id, specialty_id). The signup INSERT generates a fresh randomUUID for id, so multiple INSERTs of the same (doctor_id, specialty_id) succeed (different ids). The query in src/routes/api/cases.js:63 reads `LIMIT 1` — non-deterministic which specialty a doctor is mapped to.
**Impact:** A doctor can end up with two rows for the same specialty if the form is double-submitted; secondary specialty pickup becomes ambiguous.
**Fix scope:** small — add UNIQUE (doctor_id, specialty_id) and switch the INSERT to ON CONFLICT DO NOTHING.
**Verification:** VERIFIED-code

### P1-DATA-22 — `seedPricingData()` skips ENTIRE seed if service_regional_prices has any rows
**Severity:** P1
**Category:** seed
**Location:** src/db.js:78-374 (existingCount check at line 84)
**Description:** The function early-returns if `SELECT COUNT(*) FROM service_regional_prices > 0`. So if a single regional price row was inserted manually, the entire 264-service / 16-specialty seed is skipped on next boot. New specialties / services added in later migrations (027+) won't get default pricing. There's no incremental check ("add only the missing rows").
**Impact:** Adding a new service to a future migration won't auto-seed its EG / SAR / AED / GBP / USD rows; the admin must run the seed manually. Silent.
**Fix scope:** medium — change the gate from "any rows" to "rows for THIS service exist", and INSERT with ON CONFLICT DO NOTHING (already in place).
**Verification:** VERIFIED-code

### P1-DATA-23 — `runDataFixups()` runs UPPERCASE → lowercase status normalize on EVERY boot
**Severity:** P1
**Category:** seed
**Location:** src/db.js:60
**Description:** `UPDATE orders SET status = LOWER(status) WHERE status IS NOT NULL AND status != LOWER(status)` — every boot, scans the orders table for any uppercase status. Idempotent but wasteful; on a million-order DB this is a sequential scan every cold start. No index supports the predicate.
**Impact:** Slow boot at scale.
**Fix scope:** small — wrap with a one-time guard (admin_setting flag) or move to a one-shot migration.
**Verification:** VERIFIED-code

### P1-DATA-24 — `runDataFixups()` UPDATE on `specialties.is_visible` overrides admin edits every boot
**Severity:** P1
**Category:** seed
**Location:** src/db.js:69-72
**Description:** `UPDATE specialties SET is_visible = false WHERE id IN (...) AND is_visible != false` — forces 4 specialties (ent, general-surgery, internal-medicine, pediatrics) to invisible every boot. If a superadmin re-enables one via the dashboard, the next boot turns it back off.
**Impact:** Admin-controlled visibility settings silently revert; admin has no way to override without code change.
**Fix scope:** small — gate behind a "first-run only" admin setting, or remove (rely on migration 033 which already sets these on the seed row).
**Verification:** VERIFIED-code

### P1-DATA-25 — Migration 010 partial index on `idx_orders_acceptance_deadline` covers only 5 statuses; code uses more
**Severity:** P1
**Category:** fk-index
**Location:** src/migrations/010_broadcast_system.sql:27-29; src/workers/acceptance_watcher.js:19
**Description:** The partial index says `WHERE doctor_id IS NULL AND status IN ('pending', 'available', 'submitted', 'new', 'paid')`. But the codebase normalises statuses to lowercase via runDataFixups(), and elsewhere uses 'accepted', 'review', 'in_review'. The acceptance watcher reads `WHERE doctor_id IS NULL AND status IN ('new','submitted','paid')`. So the partial index covers more than needed (good) but if the watcher status set drifts, the index will silently stop being used — the planner will fall back to seq scan + filter.
**Impact:** Possible slow watcher cycle if anyone changes status set without updating the index.
**Fix scope:** small — add a documentation comment in the migration linking it to the worker.
**Verification:** VERIFIED-code

### P2-DATA-26 — `prescribed_medications_log.created_at` is bare TIMESTAMP (deliberately, per migration comment)
**Severity:** P2
**Category:** schema-drift
**Location:** src/migrations/025_prescribed_medications_log.sql:18-19, 51
**Description:** The author justified bare TIMESTAMP "to match convention in 001". That convention is itself the bug (DATA-11). Migrating later requires touching the log table too.
**Impact:** Drift compounds; future ML cohort queries that join across log + orders will pick the wrong column type.
**Fix scope:** medium — fix as part of the global TIMESTAMPTZ migration.
**Verification:** VERIFIED-code

### P2-DATA-27 — Migrations 020/021/030/032/036/037/038 all use `BEGIN; … COMMIT;` but do INSERT/UPDATE DML
**Severity:** P2
**Category:** migration
**Location:** src/migrations/020_orders_paid_at.sql, 021, 030, 032, 036, 037, 038
**Description:** Postgres auto-commits each statement when not in an explicit transaction. Wrapping in BEGIN/COMMIT is fine, but several of these migrations ALSO do data UPDATE that re-applies on every fresh DB. The runner does `pool.query(sql)` once per file, so the whole file is one transaction-worth of work. If the file fails halfway, the schema_migrations row is NOT inserted — but partial COMMITs CAN'T happen in a single pool.query string with explicit BEGIN. Net: behavior is correct. Documenting just to confirm.
**Impact:** None today; worth noting in case a migration is split into multiple statements one of which is non-transactional (CREATE INDEX CONCURRENTLY would fail).
**Fix scope:** N/A informational
**Verification:** VERIFIED-code

### P2-DATA-28 — `email_campaigns.approved_at` is bare TIMESTAMP, not TIMESTAMPTZ
**Severity:** P2
**Category:** schema-drift
**Location:** src/migrations/025_email_campaigns_approval.sql:17-18 (deliberate per comment)
**Description:** Comment says "matches existing email_campaigns columns: created_at, sent_at, scheduled_at" — same bug as DATA-11.
**Impact:** Same as DATA-11.
**Fix scope:** medium (rolled into the TZ-fix migration).
**Verification:** VERIFIED-code

### P2-DATA-29 — `ig_scheduled_posts.created_at` and `updated_at` are TEXT, not TIMESTAMP
**Severity:** P2
**Category:** schema-drift
**Location:** src/migrations/006_referrals.sql:104-105
**Description:** `created_at TEXT DEFAULT CURRENT_TIMESTAMP` — Postgres allows this (the default is interpreted as text). All Date arithmetic on these rows must parse the string. No range queries usable; ORDER BY works only because string-sort matches ISO-8601 in practice.
**Impact:** No `WHERE created_at > NOW() - INTERVAL '1 day'` possible without a cast; future analytics will be slow.
**Fix scope:** medium — `ALTER COLUMN … TYPE TIMESTAMPTZ USING created_at::timestamptz` after validating all writers produce parseable strings.
**Verification:** VERIFIED-code

### P2-DATA-30 — Many tables created by migrations are dead or near-dead
**Severity:** P2
**Category:** migration
**Location:** Various migrations
**Description:** Tables that exist but are barely / never referenced by application code:
- agent_heartbeats, agent_token_log, agent_config (006_referrals.sql) — no writers in src/ found.
- chat_reports (005_messaging.sql) — referenced only in routes path that may be unused.
- file_ai_checks (006_referrals.sql) — no writers found.
- ig_scheduled_posts (006_referrals.sql) — written by `src/instagram/` only; if IG automation is dormant, dead.
- app_waitlist + app_analytics_events (013) — written by /app campaign routes, low traffic.
- pre_launch_leads (001) — coming-soon page; if the page is gone, dead.
- video_calls / appointment_slots / appointment_payments (004) — video consult feature; not all of these surfaces are wired.
- `cases`, case_files, case_events, case_context, case_annotations, doctor_assignments, report_exports, case_extractions — legacy CASE-table family; some still referenced (see DATA-19) but tightly coupled to legacy code.
- order_additional_files (001) — referenced in some legacy paths.
- referral_redemptions (006) — code that writes is in src/routes/referrals.js; verify alive.
**Impact:** Schema bloat, audit confusion, accidental data leak surface (e.g. agent_token_log rows created in dev that linger forever in prod).
**Fix scope:** large — survey each, tag DEAD vs LIVE, drop the dead ones in a tombstone migration.
**Verification:** INFERRED — needs row-count from prod for confirmation.

### P2-DATA-31 — `orders.urgency_flag` BOOLEAN kept "for backwards compatibility" with `urgency_tier` as new source of truth
**Severity:** P2
**Category:** schema-drift
**Location:** src/migrations/016_urgency_tier.sql:3-4 + src/routes/order_flow.js:470/555/566
**Description:** Migration 016 says urgency_flag is kept for backwards compat; new code writes both columns simultaneously. The patient.js / order_flow.js paths set both atomically, but anyone reading just one column gets a degraded view. case_lifecycle and analytics seem to read urgency_tier; some other paths read urgency_flag. Two sources of truth.
**Impact:** Drift if a code path updates one but not the other.
**Fix scope:** medium — drop urgency_flag once all readers migrate; or document urgency_flag as a derived column with a CHECK constraint enforcing `urgency_flag = (urgency_tier <> 'standard')`.
**Verification:** VERIFIED-code

### P2-DATA-32 — `services_backup_2026_04_22` is a frozen prod backup table left in the schema
**Severity:** P2
**Category:** migration
**Location:** Referenced in src/migrations/018_dedupe_specialties.sql header comment
**Description:** A backup table from the April 22 dedup. Migration 018 says "intentionally left alone — it is a frozen snapshot from the 2026-04-22 services dedupe and must not be rewritten." But it has no migration that creates it (was created by a script), and no migration drops it. It will live in prod indefinitely.
**Impact:** Schema bloat; potential surprise for new devs introspecting the schema.
**Fix scope:** small — drop it after a confirmed cooling-off period (file a tombstone migration with a date-based safety guard).
**Verification:** NEEDS-VERIFICATION — the table only exists in prod; not in repo.

### P2-DATA-33 — `users.national_id_encrypted` BYTEA — no integrity check, no rotation strategy
**Severity:** P2
**Category:** encryption
**Location:** src/migrations/033_onboarding_schema_alignment_codify.sql:36; src/routes/auth.js:919; src/services/national-id.js:53
**Description:** Encrypted with `pgp_sym_encrypt(plaintext, key)` (single key, app-supplied). If `NATIONAL_ID_ENCRYPTION_KEY` rotates, all existing rows become unreadable — there is no key-id column or fallback. There's no HMAC integrity check (pgp_sym_encrypt does include MAC, so this is OK). No re-encryption migration helper exists.
**Impact:** Key rotation requires a custom decrypt-with-old-key + encrypt-with-new-key migration script. Today low risk (only 2 doctors use the column, per code comment).
**Fix scope:** medium — add `national_id_key_id INT` column, write a re-encryption helper.
**Verification:** VERIFIED-code

### P2-DATA-34 — `medical_records.date_of_record` is TEXT not DATE
**Severity:** P2
**Category:** schema-drift
**Location:** src/migrations/001_initial_tables.sql:243
**Description:** `date_of_record TEXT` — strings. Filtering "all medical records from last 6 months" requires casting; no index on a DATE expression possible.
**Impact:** Slow medical-records timeline queries.
**Fix scope:** small — ALTER TYPE to DATE with a USING cast.
**Verification:** VERIFIED-code

### P2-DATA-35 — `prescriptions.medications` and `valid_until` are TEXT
**Severity:** P2
**Category:** schema-drift
**Location:** src/migrations/001_initial_tables.sql:225-229
**Description:** `medications TEXT NOT NULL` — JSON-serialised medication list. Should be JSONB to query inside (per-medication filters, aggregation by drug name). `valid_until TEXT` should be DATE.
**Impact:** No JSONB GIN index possible; date comparisons require cast.
**Fix scope:** medium — ALTER TYPE in a migration with backfill validation.
**Verification:** VERIFIED-code

### P2-DATA-36 — `case_files.structured_data` JSONB has no GIN index
**Severity:** P2
**Category:** schema-drift
**Location:** src/migrations/007_case_intelligence.sql:32 + index list at 87-89
**Description:** structured_data is JSONB but no GIN index. Queries that probe inside (e.g. "all case files where document_category = 'lab'") full-scan.
**Impact:** Slow AI-extraction analytics.
**Fix scope:** small — `CREATE INDEX … ON case_files USING gin(structured_data)`.
**Verification:** VERIFIED-code

### P2-DATA-37 — `case_extractions` JSONB columns (lab_values, patient_info, documents_inventory, missing_documents, extraction_metadata) — no GIN indexes
**Severity:** P2
**Category:** schema-drift
**Location:** src/migrations/007_case_intelligence.sql:63-73, indexes at 87-89
**Description:** Five JSONB columns; only a btree index on case_id. Same issue as DATA-36 — no path-based filtering possible.
**Impact:** Slow AI extraction queries.
**Fix scope:** small — add GIN indexes on the actively-filtered columns.
**Verification:** VERIFIED-code

### P2-DATA-38 — Migration 010 explicit `ALTER TABLE orders DROP COLUMN urgent` — destructive
**Severity:** P2
**Category:** migration
**Location:** src/migrations/010_broadcast_system.sql:10
**Description:** Drops a column outright. The migration is correct in intent (data is migrated to urgency_flag first), but it's a destructive op with no rollback. Combined with DATA-1 (mobile boot path re-adds it), the round-trip is messy.
**Impact:** No new impact (covered by DATA-1).
**Fix scope:** see DATA-1.
**Verification:** VERIFIED-code

### P2-DATA-39 — `agent_heartbeats.token_cost_usd` DOUBLE PRECISION — money in floating point
**Severity:** P2
**Category:** schema-drift
**Location:** src/migrations/006_referrals.sql:113
**Description:** Money in DOUBLE PRECISION → rounding errors at sum-time. orders.price, services.base_price, doctor_fee, addon_earnings.gross_amount_egp are also DOUBLE PRECISION (mostly noted in 037 comment). addon_services.base_price_egp is INTEGER (cents-as-integer pattern), addon_earnings.gross_amount_egp is INTEGER. INCONSISTENT money type strategy across tables.
**Impact:** Sum / aggregate queries across tables produce slightly different totals.
**Fix scope:** large — choose NUMERIC(10,2) globally; migration in a maintenance window.
**Verification:** VERIFIED-code

### P2-DATA-40 — `app_waitlist` table created with SERIAL primary key while every other table uses TEXT
**Severity:** P2
**Category:** schema-drift
**Location:** src/migrations/013_app_waitlist.sql:5
**Description:** `id SERIAL PRIMARY KEY` — SERIAL/integer is the only one in the schema. Every other table uses TEXT. Cross-table joins involving app_waitlist would need casts.
**Impact:** Inconsistent join semantics.
**Fix scope:** small — leave as is (the table is isolated), but flag as inconsistent.
**Verification:** VERIFIED-code

### P2-DATA-41 — `blocked_send_attempts.id` is BIGSERIAL — also inconsistent with TEXT-id convention
**Severity:** P2
**Category:** schema-drift
**Location:** src/migrations/024_blocked_send_attempts.sql:8
**Description:** Same pattern as DATA-40.
**Impact:** Same.
**Fix scope:** small.
**Verification:** VERIFIED-code

### P2-DATA-42 — `order_files.size` INTEGER — too small for files >2GB
**Severity:** P2
**Category:** schema-drift
**Location:** src/migrate_mobile_api.js:55
**Description:** `INTEGER` is signed 32-bit, max 2^31 = 2.1GB. Medical imaging (DICOM, CT scans) can exceed this. `BIGINT` is the correct type. Today probably no >2GB upload, but the constraint is silently low.
**Impact:** Crash on save when a >2GB file is uploaded; no validation surfaces this until DB rejection.
**Fix scope:** small — ALTER TYPE BIGINT.
**Verification:** VERIFIED-code

### P2-DATA-43 — `cases.intelligence_status` exists in two places (cases AND orders) post-migration 009
**Severity:** P2
**Category:** schema-drift
**Location:** src/migrations/007_case_intelligence.sql:78-82 (cases.intelligence_status); src/migrations/009_intelligence_status_to_orders.sql (adds to orders, copies)
**Description:** Migration 009 says "cases is legacy, orders is live", and copies the data. But the cases.intelligence_status column is NOT dropped. New writes to cases (via routes/intake.js — DATA-19) won't update orders.intelligence_status. Two sources of truth.
**Impact:** Intelligence ready/processing/failed status drifts between cases and orders. Code reads from orders (case-intelligence.js:451-534) — so writes to cases.intelligence_status are silently ignored.
**Fix scope:** small — DROP COLUMN cases.intelligence_status in a follow-up migration.
**Verification:** VERIFIED-code

### P2-DATA-44 — `services.specialty_id` FK was added in 041, but `orders.specialty_id`, `orders.service_id`, `orders.doctor_id`, `orders.patient_id` have NO FK
**Severity:** P2
**Category:** fk-index
**Location:** src/migrations/001_initial_tables.sql:29-55
**Description:** orders has 4 columns that are foreign keys in concept (specialty_id, service_id, doctor_id, patient_id). NONE has a FK. Deleting a doctor doesn't refuse / cascade / null-out their orders. Deleting a service silently leaves orders pointing at a non-existent row. Migration 041 added the FK on services.specialty_id; the orders FKs are still missing.
**Impact:** Orphaned references; downstream JOINs return NULL; analytics under-count.
**Fix scope:** medium — add FK with ON DELETE SET NULL or RESTRICT (depends on policy).
**Verification:** VERIFIED-code

### P3-DATA-45 — `idx_orders_payment_status` is a plain b-tree on a low-cardinality column
**Severity:** P3
**Category:** fk-index
**Location:** src/migrations/003_indexes.sql:10
**Description:** payment_status has ~5 values (unpaid, paid, failed, refunded, captured). A plain btree gets used for equality but is large. Better as a partial index on `WHERE payment_status = 'paid'` (the high-cardinality filter).
**Impact:** Slightly larger index, marginal slowdown on bulk loads.
**Fix scope:** small — replace with partial.
**Verification:** VERIFIED-code

### P3-DATA-46 — `email_campaigns.approved_by` is TEXT but no FK to users.id
**Severity:** P3
**Category:** fk-index
**Location:** src/migrations/025_email_campaigns_approval.sql:25-30
**Description:** approved_by is intended to reference users.id. No FK; orphan possible if a user is later deleted.
**Impact:** Approval audit trail breaks on user delete (rare).
**Fix scope:** small.
**Verification:** VERIFIED-code

### P3-DATA-47 — `pre_launch_leads.email` not UNIQUE; same person can sign up twice
**Severity:** P3
**Category:** schema-drift
**Location:** src/migrations/001_initial_tables.sql:206-218
**Description:** No UNIQUE on email; index added in 003 but as plain btree. Duplicate signups from same email are allowed. (app_waitlist DOES have a unique on email+platform — different table.)
**Impact:** Email lists may dedupe at send-time only; potential to over-count leads.
**Fix scope:** small — add UNIQUE.
**Verification:** VERIFIED-code

### P3-DATA-48 — schema_migrations is append-only; no rollback, no failure marker
**Severity:** P3
**Category:** migration
**Location:** src/db.js:14-44
**Description:** The runner is "all-or-nothing per file" — INSERT INTO schema_migrations only AFTER pool.query(sql) succeeds. No failed-migration row, no rollback path. If a migration fails partway and pool.query throws, the file is NOT recorded; on next boot, the runner re-runs the whole file. That's fine for fully-idempotent files (which is the convention) but DOOMS any migration that does partial work and then crashes.
**Impact:** Operator-visible boot loop on broken migration; no audit of failed attempts.
**Fix scope:** medium — track filename, status (success|failed), error message, ran_at; add an optional --reset that clears a failed row.
**Verification:** VERIFIED-code

### P3-DATA-49 — `seed_specialties.js` (Catalog B) DISABLED, BUT exported and importable
**Severity:** P3
**Category:** seed
**Location:** src/seed_specialties.js:1-197 + src/server.js:467-479 (commented call)
**Description:** The function is exported (`module.exports = { seedSpecialtiesAndServices }`) and could be called from any future route or script. The disable is a code-comment, not a runtime guard. Anyone re-enabling it without re-reading the warning header re-creates the 47 demo "spec-*" rows.
**Impact:** Risk of accidental re-enable (low frequency, high impact).
**Fix scope:** small — wrap the function body with `throw new Error('Catalog B seeder is permanently disabled — see header')` if a feature flag isn't set.
**Verification:** VERIFIED-code

### P3-DATA-50 — Migration 011 adds UNIQUE (specialty_id, name) on services — but deduplication preconditions are an external script
**Severity:** P3
**Category:** migration
**Location:** src/migrations/011_services_unique_name.sql
**Description:** The migration's own header says it depends on `scripts/dedupe_services.js --live` having been run first. If a fresh-DB rebuild ever runs migrations against a partially seeded DB without that script, 011 will fail mid-way (constraint violation) and stop migration 012+. Recovery requires manual SQL.
**Impact:** Brittle bootstrap order; not idempotent on a non-deduped DB.
**Fix scope:** medium — embed the dedup logic INSIDE the migration as a DELETE-of-duplicates pre-step, or assert preconditions and abort with a clear message.
**Verification:** VERIFIED-code

### P3-DATA-51 — `migration 042` DROPs `payments` table; the legacy boot-path (migrate_mobile_api.js:81-94) re-creates it on next boot
**Severity:** P3
**Category:** schema-drift
**Location:** src/migrations/042_paymob_intentions.sql:54-70 (DROP) + src/migrate_mobile_api.js:81-94 (CREATE TABLE IF NOT EXISTS payments)
**Description:** Migration 042 DROPs the `payments` table after a row-count guard. After 042 runs, on the very next boot, migrateForMobileApi re-runs and CREATE TABLE IF NOT EXISTS payments will RE-CREATE it (empty). The DROP is effectively a no-op on a system that boots more than once.
**Impact:** Same column DATA-2 covers — the table is eternally undead. The DATA-2 SELECT then runs against an empty table and returns no rows (no crash, but always "pending" status).
**Fix scope:** small — remove the CREATE TABLE payments block from migrate_mobile_api.js.
**Verification:** VERIFIED-code

### P3-DATA-52 — Migration 015 creates otp_codes; migrate_mobile_api.js also creates otp_codes
**Severity:** P3
**Category:** schema-drift
**Location:** src/migrations/015_otp_codes_table.sql + src/migrate_mobile_api.js:60-67
**Description:** Both create otp_codes with IF NOT EXISTS. No conflict — 015 wins on a fresh DB, mobile-boot is no-op. But it's drift documentation: two sources of truth for the same DDL.
**Impact:** None (idempotent), but encodes the bug-class.
**Fix scope:** small — remove from migrate_mobile_api.js.
**Verification:** VERIFIED-code

### P3-DATA-53 — Migration 033 creates doctor_specialties; migrate_mobile_api.js also creates doctor_specialties
**Severity:** P3
**Category:** schema-drift
**Location:** src/migrations/033_onboarding_schema_alignment_codify.sql:88-94 + src/migrate_mobile_api.js:97-104
**Description:** Same as DATA-52.
**Impact:** None.
**Fix scope:** small.
**Verification:** VERIFIED-code

### P3-DATA-54 — `users.muted_until`, `users.last_seen_at` — TIMESTAMP, no index
**Severity:** P3
**Category:** fk-index
**Location:** src/migrations/002_column_additions.sql:336-339; src/migrations/033:67-69
**Description:** Both used in WHERE clauses (broadcast skip-muted; auto-pause stale-user); no index. Today small user count, fine.
**Impact:** Slow at 10k+ users.
**Fix scope:** small.
**Verification:** VERIFIED-code

### P3-DATA-55 — `password_reset_tokens.token` UNIQUE — but no index on user_id
**Severity:** P3
**Category:** fk-index
**Location:** src/migrations/001_initial_tables.sql:142-149
**Description:** Lookups by user_id ("does this user have any active reset?") are scans.
**Impact:** Slow at scale.
**Fix scope:** small — add idx_password_reset_user_id.
**Verification:** VERIFIED-code

### P3-DATA-56 — Migrations sometimes use `TIMESTAMP DEFAULT NOW()` and sometimes `TIMESTAMP DEFAULT CURRENT_TIMESTAMP` — same outcome but inconsistent
**Severity:** P3
**Category:** migration
**Location:** src/migrations/006_referrals.sql:104, 105 (CURRENT_TIMESTAMP) vs 25/40/64 (NOW())
**Description:** Cosmetic. Postgres treats both identically. Inconsistent style.
**Impact:** Aesthetic only.
**Fix scope:** small — pick one.
**Verification:** VERIFIED-code

### P3-DATA-57 — `doctor_assignments.case_id` references `cases.id`, but `case_id == orders.id` is the de-facto truth
**Severity:** P3
**Category:** schema-drift
**Location:** src/migrations/001_initial_tables.sql:124-132; src/case_lifecycle.js:1652
**Description:** Column NAMED case_id but real-world value is orders.id (since cases is legacy, orders is live; same id pattern). Confusing for new devs and analytics.
**Impact:** Documentation/onboarding drag.
**Fix scope:** medium — rename column to order_id (with ALTER TABLE … RENAME COLUMN), wire compatibility shim.
**Verification:** VERIFIED-code

### P3-DATA-58 — `orders.report_url` TEXT — no length limit, no validation
**Severity:** P3
**Category:** schema-drift
**Location:** src/migrations/001_initial_tables.sql:48
**Description:** Standard practice; not strictly a bug.
**Impact:** None.
**Fix scope:** N/A.
**Verification:** VERIFIED-code

### P3-DATA-59 — `users.email` UNIQUE — but no NOT NULL, so multiple users can have NULL email
**Severity:** P3
**Category:** schema-drift
**Location:** src/migrations/001_initial_tables.sql:5
**Description:** UNIQUE on a nullable column allows multiple NULL rows. NULL is the placeholder for "patient signed up via WhatsApp / phone, no email". OK for the use case but the index is consistently sparse.
**Impact:** None functional; just confirming the design.
**Fix scope:** N/A.
**Verification:** VERIFIED-code

### P3-DATA-60 — `runDataFixups()` and `seedPricingData()` run in series during boot — no transaction
**Severity:** P3
**Category:** seed
**Location:** src/db.js:48-52
**Description:** runDataFixups runs first, seedPricingData runs second. If runDataFixups fails, seedPricingData never runs. If seedPricingData partially succeeds (it uses withTransaction internally), runDataFixups already committed.
**Impact:** Boot-time half-initialised state on rare failure.
**Fix scope:** small — wrap in a top-level transaction OR explicitly tolerate partial init.
**Verification:** VERIFIED-code

---

## Cross-cutting recommendations (not findings)

1. The duplicate-write pattern (`urgency_tier` + `urgency_flag`, `notifications` legacy + mobile) suggests the codebase is still in a multi-quarter migration that was never finished. Pick a finish line.
2. Several migrations document that they "codify what was applied directly to prod" (033, 037). The fact that this happened more than once means the dev workflow allows out-of-band schema changes. Tighten that.
3. The TEXT-everywhere convention for ids is fine for app-level integrity but precludes cheap FKs. The 4-FK additions in 019/028/041 show an evolving stance — pick one and apply systematically.
4. seedPricingData and migrate_mobile_api.js have grown into a parallel migration system. Fold them into the file-based runner so schema changes have a single audit trail.

---

## Coverage notes

- All 43 migration files were read in full.
- migrate_mobile_api.js was read in full.
- Soft-delete coverage was checked across patient.js, superadmin.js, doctor.js, payments.js, sla_worker.js, case_lifecycle.js (greps showed 0 hits in the four highest-traffic files).
- FK list was exhaustive (only 7 declared in the schema).
- Timestamp-type drift was confirmed by counting TIMESTAMP vs TIMESTAMPTZ across all migrations.
- Code references to dead tables checked via `grep -rn "FROM <table>"`.
- prod schema_migrations rows were NOT inspected (that requires DB access). Findings DATA-7 (gap 029) and DATA-32 (services_backup table) are flagged NEEDS-VERIFICATION accordingly.


---

# Section 09 — UI/UX audit

# UI/UX Pre-Launch Audit — 2026-05-06

## Scorecard

| Metric | Count |
|---|---|
| Total `.ejs` views | 122 (+ 17 `.bak` siblings) |
| Views using `t()` helper directly | 1 (`register.ejs`) |
| Views using `tt()` (server-injected) | 0 (5 define their **own** local `tt(en,ar)` shadow that is *not* `res.locals.tt`) |
| Views using inline `lang === 'ar' ? … : …` | 89 |
| Views with no i18n primitive at all (English-only) | **33** |
| Views translated (≥1 i18n primitive present) | 89 / 122 ≈ **73%** |
| Views with explicit empty-state markup | 44 |
| Views referencing loading/skeleton/disabled-on-submit | 10 |
| `loading-skeleton.ejs` partial referenced from any view | **0** (dead code) |
| `.bak` files (counted as debt) | 17 |
| `<a href="#">` tap-traps | 5 |
| Skip-to-content links | **0** |
| `<meta viewport>` set in all 3 layouts (`portal/auth/public`) | yes |
| `<meta viewport>` in patient v2 head partial | yes (with `viewport-fit=cover`) |
| Locale-key parity (`src/locales/en.json` vs `ar.json`) | EN=102, AR=170 — **68 keys exist only in AR**, none EN-only |
| Email templates (`templates/email/{en,ar}/*.hbs`) | same 21 file names in both, no obvious size drift |

Two parallel i18n systems exist:
- `src/i18n.js` (inline `en`/`ar` JS dicts, ~80 keys each, exposed via `res.locals.t`).
- `src/locales/{en,ar}.json` (read by `src/i18n/i18n.js getTranslator()`) — **not wired into `res.locals` at all** (only `t` is, from `src/i18n.js`).

The locale JSON files are loaded but never consumed by the EJS layer. Verified: `grep getTranslator src/` returns only the definition. Most views translate via inline ternaries on `isAr`/`lang === 'ar'`, bypassing both i18n systems.

---

## i18n / Bilingual coverage

### P0-UI-1 — Marketing homepage hardcoded English
**Severity:** P0
**Category:** i18n
**Location:** /Users/ziadelwahsh/tashkheesa-portal/src/views/index.ejs:1-end (esp. `<html lang="en">` line 2; nav links 77-80; meta description; JSON-LD)
**Description:** Entire landing page is rendered in English with `<html lang="en">` hardcoded, `<meta og:locale content="en_US">`, and no `t()`/`tt()`/`isAr` branching anywhere. Arabic-language users hitting `/` (the most common entry) get an English-only page even when their cookie is set to `ar`.
**Impact:** AR-speaking visitors see EN homepage; SEO loses the AR locale entirely; lang toggle in `partials/header.ejs` works on every page except the one most users land on.
**Fix scope:** large
**Verification:** VERIFIED-code

### P0-UI-2 — `/about` page hardcoded English
**Severity:** P0
**Category:** i18n
**Location:** /Users/ziadelwahsh/tashkheesa-portal/src/views/about.ejs:7-end
**Description:** All headings, mission copy, "How It Works" steps, "Our Specialists" bullets are static English. Public layout (`partials/header.ejs`) renders `<html dir="rtl">` correctly when AR cookie is set, but the page body is English — producing right-aligned English in AR mode.
**Impact:** AR users see broken bilingual experience on a top-of-funnel page.
**Fix scope:** medium
**Verification:** VERIFIED-code

### P0-UI-3 — `/services` page hardcoded English
**Severity:** P0
**Category:** i18n
**Location:** /Users/ziadelwahsh/tashkheesa-portal/src/views/services.ejs:1-end
**Description:** Entire services & pricing page is English (`grep -c "isAr\|lang === 'ar'\|t("` returns 0). Embedded `<style>` block + content. Pricing card copy, hero, featured spotlight all static EN.
**Impact:** AR-speaking patients deciding whether to pay see English; missed conversion + trust loss.
**Fix scope:** large
**Verification:** VERIFIED-code

### P0-UI-4 — `/contact` page hardcoded English
**Severity:** P0
**Category:** i18n
**Location:** /Users/ziadelwahsh/tashkheesa-portal/src/views/contact.ejs:1-end
**Description:** Headings ("Contact Us", "Send Us a Message"), form labels ("Name", "Email", "Subject"), select options ("General Inquiry", "Refund Request", etc.), placeholders, and submit button text are all English-only.
**Impact:** AR patients can't read the contact form or know what `Refund Request` means.
**Fix scope:** medium
**Verification:** VERIFIED-code

### P0-UI-5 — Legal pages (privacy/terms/refund/delivery) hardcoded English
**Severity:** P0
**Category:** i18n
**Location:** /Users/ziadelwahsh/tashkheesa-portal/src/views/privacy.ejs, terms.ejs, refund_policy.ejs, delivery_policy.ejs (all four)
**Description:** None of the four legal pages contain a single i18n primitive. `<html dir>` flips to RTL via `partials/header.ejs` but body content stays English, producing right-aligned English paragraphs.
**Impact:** Egyptian regulators expect Arabic legal content; unenforceable consent for AR-only users; refund disputes harder.
**Fix scope:** large (real legal copy needed)
**Verification:** VERIFIED-code

### P0-UI-6 — `coming_soon.ejs` (the page `/order/start` redirects to) is English-only
**Severity:** P0
**Category:** i18n
**Location:** /Users/ziadelwahsh/tashkheesa-portal/src/views/coming_soon.ejs:1-end (e.g. lines 267-269, 273-282, 286-339)
**Description:** "Launching Soon!", "Expert Medical Second Opinions Platform", feature bullets, the entire interest-capture form (labels: Name *, Email *, Phone, Language, Service Interest, Tell us about your case), submit button, success message, and CTAs ("Browse Services", "Learn More About Us") are all hardcoded English. Confirmed by `grep` returning zero i18n markers.
**Impact:** Currently `/order/start` is hard-redirected here (`src/routes/order_flow.js:115`) — i.e. **every patient who tries to start an order today** sees an English-only marketing page. AR patients are blocked at the funnel entrance.
**Fix scope:** medium
**Verification:** VERIFIED-code

### P0-UI-7 — `/sandbox/order-intake` has English-only nav and form
**Severity:** P1 (internal-ish; gated by API key)
**Category:** i18n
**Location:** /Users/ziadelwahsh/tashkheesa-portal/src/views/sandbox_order_intake.ejs:14-50
**Description:** Sidebar nav links ("Dashboard", "New Case", "Alerts", "Profile", "Logout") and all form labels are English-only. Used by API integrators but still patient-context.
**Impact:** Internal/integration users only.
**Fix scope:** small
**Verification:** VERIFIED-code

### P0-UI-8 — Marketing index hardcodes `<html lang="en">`
**Severity:** P0
**Category:** rtl / i18n
**Location:** /Users/ziadelwahsh/tashkheesa-portal/src/views/index.ejs:2
**Description:** `<html lang="en">` is a literal string, not driven by `lang` local. The `<meta property="og:locale" content="en_US">` is also hardcoded. So even if the page copy were translated, screen readers and OG locale would still report English.
**Impact:** A11y + SEO — RTL screen reader announcement wrong, search engines see only EN locale.
**Fix scope:** small
**Verification:** VERIFIED-code

### P1-UI-9 — `appointment_detail.ejs` (patient-reachable) hardcoded English
**Severity:** P1
**Category:** i18n
**Location:** /Users/ziadelwahsh/tashkheesa-portal/src/views/appointment_detail.ejs:4-9, 33-40, 138, 152, 158
**Description:** Status map labels (Pending/Confirmed/Cancelled/No Show), breadcrumb, page title "Appointment Details", and native `prompt('Please provide a reason for cancellation:')` + `alert('Failed to cancel')` + `alert('Network error')` are English-only. Browser native `prompt()`/`alert()` cannot be translated. `portalRole` toggles between doctor and patient — *both* roles read this view.
**Impact:** AR patient cancelling a video appointment sees English popup prompts; AR doctor sees English status pills.
**Fix scope:** medium (replace native popups with custom modal)
**Verification:** VERIFIED-code

### P1-UI-10 — `messages.ejs` shows doctor copy on patient view
**Severity:** P1
**Category:** i18n / copy bug
**Location:** /Users/ziadelwahsh/tashkheesa-portal/src/views/messages.ejs:49
**Description:** Patient branch renders `<p class="portal-hero-subtitle">Your conversations with patients</p>` — copy is for doctors, not patients. Both branches (line 49 and 67) use the identical string `'Your conversations with patients'` in EN and `'محادثاتك مع المرضى'` in AR.
**Impact:** Patients see "Your conversations with patients" instead of "with your doctor" — confusing wrong copy in both languages.
**Fix scope:** small
**Verification:** VERIFIED-code

### P1-UI-11 — `order_payment.ejs` SLA card content English-only inside otherwise bilingual page
**Severity:** P1
**Category:** i18n
**Location:** /Users/ziadelwahsh/tashkheesa-portal/src/views/order_payment.ejs:54-62
**Description:** Page header is bilingual but SLA card titles ("Standard review · 72 hours", "Priority review · 24 hours") and their descriptions ("Specialist-reviewed written opinion delivered digitally.", "Auto-escalation kicks in if the SLA window is missed.", etc.) are hardcoded English inside an `<input type="radio">` group.
**Impact:** AR users selecting urgency see English radio descriptions next to AR labels — broken bilingual experience at the moment they pay.
**Fix scope:** small
**Verification:** VERIFIED-code

### P1-UI-12 — Error messages from server not translated in `register.ejs`, `reset_password.ejs`, `intake_form.ejs`
**Severity:** P1
**Category:** i18n / error-state
**Location:** /Users/ziadelwahsh/tashkheesa-portal/src/views/register.ejs:13, reset_password.ejs:22-28, intake_form.ejs:36
**Description:** When server returns an error string, it's printed verbatim with `<%= error %>` — the route always emits English (e.g. "Email already in use"). `login.ejs` and `forgot_password.ejs` have a translation map for known errors, but `register`, `reset_password`, and `intake_form` don't. AR users see EN errors mid-form.
**Impact:** Confusing failure experience for AR users at registration/password recovery.
**Fix scope:** small
**Verification:** VERIFIED-code

### P1-UI-13 — Two parallel i18n systems; one is dead code
**Severity:** P1
**Category:** i18n / debt
**Location:** /Users/ziadelwahsh/tashkheesa-portal/src/i18n.js (inline dicts, used) vs /Users/ziadelwahsh/tashkheesa-portal/src/locales/{en,ar}.json + /Users/ziadelwahsh/tashkheesa-portal/src/i18n/i18n.js (loaded but unused)
**Description:** `src/middleware.js:6` imports `t` from `./i18n` (the inline file). The `getTranslator` factory in `src/i18n/i18n.js` is never called from server.js, middleware, or any route (verified by `grep -r "getTranslator"`). `locales/en.json` (102 keys) and `locales/ar.json` (170 keys) contain `patientDashboard.*` and `patientOrder.*` namespaces that match no view's calls to `t()`.
**Impact:** Translators editing `locales/*.json` make zero visible changes. Future contributors waste hours debugging "translation not appearing". Locale-parity tools (CI checks) operate on the wrong file.
**Fix scope:** medium (delete one or wire the other through)
**Verification:** VERIFIED-code

### P1-UI-14 — Locale JSON files are out of sync (68 AR-only keys, 0 EN-only)
**Severity:** P1
**Category:** i18n
**Location:** /Users/ziadelwahsh/tashkheesa-portal/src/locales/en.json vs ar.json
**Description:** AR has 170 leaf keys, EN has 102. 68 keys exist only in AR (e.g. `patientDashboard.welcome`, `patientDashboard.tabs.all`, `patientOrder.payment.helper`, `patientOrder.activity.none`). Even though these JSON files aren't currently consumed by views (see P1-UI-13), the schema drift indicates work-in-progress translations that never landed in EN.
**Impact:** If/when these files are wired up, AR users get translated strings and EN users get key paths displayed verbatim.
**Fix scope:** small
**Verification:** VERIFIED-code

### P2-UI-15 — Three different locale-helper signatures coexist
**Severity:** P2
**Category:** i18n / debt
**Location:** views entire tree
**Description:** Three patterns are in active use:
- `<%= t('key.path') %>` — server `res.locals.t` from `src/i18n.js` (only `register.ejs` uses this).
- `<%= tt('key', 'EN', 'AR') %>` — three-arg server `res.locals.tt` (no view uses it; instead 5 views define their *own* local 2-arg `function tt(en, ar)` shadowing the server version: `video_call_room.ejs`, `video_appointment.ejs`, `video_call_ended.ejs`, `appointment_availability.ejs`, `appointment_booking.ejs`).
- Local `function L(en, ar)` (~19 views) and `function _t(en, ar)` (~15 doctor v2 views) — both are 2-arg helpers that bypass i18n keys entirely and inline both languages.
**Impact:** Translators must hunt across three patterns; copying the AR string from a key file isn't possible because most strings live in the `.ejs`. CI lint for missing translations is impossible.
**Fix scope:** large (consolidation)
**Verification:** VERIFIED-code

### P2-UI-16 — `services.ejs` has zero `<html lang>` reactive switch — inherited from layout, but content is EN
**Severity:** P2 (covered by UI-3 but called out separately for SEO)
**Category:** i18n / SEO
**Location:** /Users/ziadelwahsh/tashkheesa-portal/src/views/services.ejs:1-end
**Description:** Layout sets `<html dir="rtl">` correctly under AR; content is EN. AR Google sitemap will index EN content under AR locale.
**Fix scope:** medium
**Verification:** INFERRED

### P2-UI-17 — `notify/notification_titles.js` returns title_en + title_ar; only 4 templates carry interpolation; default fallback humanizes with `{template_name}` raw
**Severity:** P2
**Category:** i18n
**Location:** /Users/ziadelwahsh/tashkheesa-portal/src/notify/notification_titles.js:82-95
**Description:** The friendly-title map is bilingual for ~30 templates. Falls back to `humanizeTemplate(key)` (e.g. `'sla_reminder_24h'` → `'Sla Reminder 24H'`) for both EN and AR when missing. AR users see snake_case English keys for any new template that misses the map.
**Impact:** Any newly added notification template that the team forgets to register surfaces in AR as Title-Cased English.
**Fix scope:** small (add fallback warning + lint)
**Verification:** VERIFIED-code

---

## RTL / LTR

### P1-UI-18 — `<html dir>` correct, but inline `border-left` / `margin-left` won't flip
**Severity:** P1
**Category:** rtl
**Location:** patient_records.ejs:80, patient_reviews.ejs:60, patient_referrals.ejs:47, admin.ejs:411, admin_chat_moderation_detail.ejs:107, admin_doctors.ejs:137, admin_orders.ejs:166-169, admin.ejs:343,392, superadmin.ejs:387, admin_analytics.ejs:89, video_appointment.ejs:44, public_case_new.ejs:140, ops-dashboard.ejs:128, help_doctor_guide.ejs:392, patient_walkthrough.ejs:475
**Description:** 17+ inline-style occurrences of `border-left:`, `margin-left:`, `margin-right:`, `padding-left:` that won't mirror in RTL. Notably patient-facing: the accent-stripe alert/intro cards on `patient_records.ejs`, `patient_reviews.ejs`, `patient_referrals.ejs` have `border-left:4px solid ...` — in AR mode the stripe sits on the wrong (visually-trailing) edge.
**Impact:** Visible AR styling regression on patient list intro cards.
**Fix scope:** small (replace with `border-inline-start`)
**Verification:** VERIFIED-code

### P2-UI-19 — Local `tt()`/`L()`/`_t()` use ASCII directional arrows for navigation
**Severity:** P2
**Category:** rtl
**Location:** /Users/ziadelwahsh/tashkheesa-portal/src/views/portal_doctor_case.ejs:86,256
**Description:** Back-button copy uses `'→ العودة للقائمة'` (AR) and `'← Back to cases'` (EN). The arrow direction is correctly mirrored, but it's done by hand, not via CSS `transform: scaleX(-1)` on an SVG — every place Back is rendered must remember to flip. Most other views also use literal arrows (`←`/`→`) inline.
**Impact:** Easy regression where someone copies the EN string into AR without flipping the arrow.
**Fix scope:** medium (use SVG icons with `flipRtl: true`)
**Verification:** VERIFIED-code

### P2-UI-20 — `partials/patient/icon.ejs flipRtl` flag exists but isn't applied to back/breadcrumb chevrons
**Severity:** P2
**Category:** rtl
**Location:** /Users/ziadelwahsh/tashkheesa-portal/src/views/partials/patient/mobile-tabbar.ejs:46 explicitly passes `flipRtl: false` for "More" caret
**Description:** Patient v2 icon partial supports a `flipRtl` flag, but breadcrumb separators (`›`/`&rsaquo;` in `admin_*.ejs`) are literal Unicode and don't mirror in RTL mode.
**Impact:** RTL admin breadcrumbs read backwards.
**Fix scope:** small
**Verification:** VERIFIED-code

### P3-UI-21 — Numbers shown in Eastern Arabic vs Western Arabic inconsistent
**Severity:** P3
**Category:** rtl / i18n
**Location:** patient_dashboard.ejs:30 (uses `toLocaleDateString('ar-EG')`), portal_doctor_dashboard.ejs:18 (`_fmtNum` uses `toLocaleString`), portal_doctor_earnings.ejs:11 (locale-aware), but admin views use raw `<%= count %>` everywhere.
**Description:** Some patient/doctor v2 views format numbers `n.toLocaleString('ar-EG')` (Eastern Arabic-Indic digits). Admin views always print Western digits. Patient `patient_new_case.ejs` SLA labels use Eastern digits in AR (`٧٢ ساعة`), but the same case's deadline ticker uses Western digits.
**Impact:** Cosmetic inconsistency; not blocking.
**Fix scope:** medium
**Verification:** VERIFIED-code

---

## Mobile responsiveness

### P2-UI-22 — Viewport meta is set everywhere
**Severity:** P3 (positive finding, recorded)
**Category:** mobile
**Location:** layouts/{auth,public,portal}.ejs all have `<meta viewport>`. partials/patient/head.ejs uses `viewport-fit=cover`.
**Description:** No views are missing the viewport meta. Confirmed.
**Verification:** VERIFIED-code

### P1-UI-23 — `coming_soon.ejs` form-row uses `grid-template-columns: repeat(2, 1fr)` with explicit narrow override only at `max-width: 768px`
**Severity:** P1
**Category:** mobile
**Location:** /Users/ziadelwahsh/tashkheesa-portal/src/views/coming_soon.ejs:124-129, 246-249
**Description:** Two side-by-side fields (Name/Email, Phone/Language) on a 320px iPhone SE viewport will be ~140px each before padding — Egyptian phone numbers need ~180px to fit `+201012345678`. Breakpoint at 768px not tight enough.
**Impact:** Phone field cramped on small phones; AR placeholder `مثال: +201012345678` may truncate.
**Fix scope:** small (lower breakpoint to 480px or use `auto-fit`)
**Verification:** VERIFIED-code

### P1-UI-24 — Admin tables overflow on mobile
**Severity:** P1
**Category:** mobile
**Location:** /Users/ziadelwahsh/tashkheesa-portal/src/views/admin_pre_launch_leads.ejs:38 (`<div class="card" style="overflow-x:auto;">` — 7-column table); admin_orders.ejs, admin_doctors.ejs, admin.ejs all use `<table>` without responsive collapse.
**Description:** 7+ column admin tables have no responsive treatment beyond `overflow-x:auto`. Acceptable for desktop-first admin, but admin users on field-tablet flow lose half the columns.
**Impact:** Admins reviewing on iPad/phone need horizontal scroll for every order row.
**Fix scope:** medium
**Verification:** VERIFIED-code

### P3-UI-25 — Patient `border-inline-start: 3px` accent on alert cards (good!) but admin uses fixed `border-left:4px solid #f59e0b`
**Severity:** P3
**Category:** mobile / rtl
**Location:** patient_alerts.ejs:119 (uses logical), admin.ejs:411 (uses physical)
**Description:** Patient v2 chrome correctly uses `border-inline-start`; admin v1 uses physical `border-left`. Inconsistent across portal layers.
**Fix scope:** small
**Verification:** VERIFIED-code

---

## Accessibility

### P1-UI-26 — No skip-to-content links anywhere
**Severity:** P1
**Category:** a11y
**Location:** layouts/* and partials/* — `grep -r "skip-to-content\|skip-link"` returns zero hits
**Description:** Sighted keyboard users (and AT users) can't bypass the 8-item sidebar/topbar to reach `<main id="main-content">`. The `id="main-content"` exists but no anchor jumps to it.
**Impact:** WCAG 2.1 SC 2.4.1 fail.
**Fix scope:** small
**Verification:** VERIFIED-code

### P1-UI-27 — `coming_soon.ejs` form labels not associated with inputs
**Severity:** P1
**Category:** a11y
**Location:** /Users/ziadelwahsh/tashkheesa-portal/src/views/coming_soon.ejs:292-329
**Description:** Six labels (`<label>Name *</label>`, `<label>Email *</label>`, etc.) have no `for` attribute and inputs have no `id`. Screen readers can't pair labels to fields. Same pattern in `contact.ejs:39-60` (`<label class="form-label">Name</label>` + bare `<input name="name">`).
**Impact:** AT users (also tap target — clicking the label doesn't focus the input) blocked from completing the lead form.
**Fix scope:** small
**Verification:** VERIFIED-code

### P1-UI-28 — Native `alert()` and `prompt()` used instead of accessible modals
**Severity:** P1
**Category:** a11y / i18n
**Location:** appointment_detail.ejs:138 `prompt('Please provide a reason…')`, 152 `alert(data.error || 'Failed to cancel')`, 158 `alert('Network error')`; coming_soon.ejs:386, 392 (also `alert(...)`).
**Description:** Browser-native `alert()`/`prompt()` are not localizable, ignore CSP nonce attribution context, and are inaccessible (not screen-reader-friendly on iOS Safari).
**Impact:** Patient cancelling an appointment gets a non-translatable English browser dialog; mobile screen reader users may miss it.
**Fix scope:** medium (replace with custom modal that uses `aria-live`)
**Verification:** VERIFIED-code

### P2-UI-29 — Five `<a href="#">` anchors used for JS handlers
**Severity:** P2
**Category:** a11y
**Location:** five hits across views (count: `grep -c "<a href=\"#\""`).
**Description:** Anchors with `href="#"` are keyboard-trap risks (clicking jumps to top of page) and miscommunicate intent to AT. Should be `<button>`.
**Impact:** Mild a11y degradation.
**Fix scope:** small
**Verification:** VERIFIED-code

### P3-UI-30 — `outline:none` used on form inputs but `:focus` ring provided
**Severity:** P3 (false positive risk)
**Category:** a11y
**Location:** public/css/portal-components.css:309, plus 30 occurrences across CSS files.
**Description:** `.p-form-input { outline: none; }` is followed by a `box-shadow` ring on `:focus` (line 312-317). Not a regression. **However** other CSS files (doctor-portal.css, doctor-case-detail.css, messages.css, doctor-appointments.css, styles.css) have unaudited `outline:none` rules that may strip focus indication on non-input elements (buttons, links). Worth a sweep.
**Fix scope:** medium
**Verification:** NEEDS-VERIFICATION

### P2-UI-31 — `loading-skeleton.ejs` partial built but never included from any view
**Severity:** P2
**Category:** loading-state / debt
**Location:** /Users/ziadelwahsh/tashkheesa-portal/src/views/partials/patient/loading-skeleton.ejs (defined; `grep -r "loading-skeleton"` shows zero includes)
**Description:** The partial supports `aria-busy="true"` and `aria-live="polite"` and would be the right answer for async screens; it's just dead code.
**Impact:** Async data fetches (patient bell dropdown, doctor queue) show a blank area before content arrives.
**Fix scope:** medium (wire skeleton into bell dropdown, doctor cases page, etc.)
**Verification:** VERIFIED-code

### P3-UI-32 — `<img>` without `alt`
**Severity:** P3
**Category:** a11y
**Location:** doctor_prescribe.ejs:363 (signature `<img>`), patient_case_report.ejs:178 (annotation `<img>`), portal_doctor_profile.ejs:636 (signature `<img>` — but in dialog).
**Description:** Three `<img>` elements without `alt`. Annotation image is dynamically generated content; signature image is functional. All three should at minimum be `alt=""` (decorative) or have descriptive text.
**Fix scope:** small
**Verification:** VERIFIED-code

### P3-UI-33 — Some buttons lack accessible label
**Severity:** P3
**Category:** a11y
**Location:** partials/patient/topbar.ejs:26 (bell button has `aria-label`, OK); video_call_room.ejs:288-305 (mute/camera/screen-share/end buttons use `title=` but no `aria-label`)
**Description:** Title attribute is *not* an accessible name on all platforms (esp. iOS VoiceOver). Use `aria-label`.
**Fix scope:** small
**Verification:** VERIFIED-code

---

## Empty states

### P2-UI-34 — Most patient list views have bilingual empty states (positive finding)
**Severity:** P3 (recorded for accuracy)
**Category:** empty-state
**Location:** patient_alerts.ejs:78-92, patient_appointments_list.ejs:80-86, patient_prescriptions.ejs:58-66, patient_referrals.ejs:94-100, patient_reviews.ejs:50-56, patient_records.ejs:113-118, portal_doctor_earnings.ejs:30-46
**Description:** All 7 patient/doctor list pages above show empty state copy in EN+AR. `messages.ejs` empty state is also localized.
**Verification:** VERIFIED-code

### P2-UI-35 — Admin dashboard empty states English-only
**Severity:** P2
**Category:** empty-state / i18n
**Location:** admin_pre_launch_leads.ejs:33-36, admin_orders.ejs (no leads case fallback), admin_doctors.ejs, admin.ejs
**Description:** "No pre-launch leads yet." / "Leads will appear here when visitors submit interest through the Coming Soon page." — English only. Most admin empty states never include `isAr` branching.
**Impact:** Admin AR users (rare but real for ops staff) see English fallbacks.
**Fix scope:** small (low-priority — admin is internal)
**Verification:** VERIFIED-code

---

## Loading states

### P1-UI-36 — Forms submit without disabling button or showing spinner (most views)
**Severity:** P1
**Category:** loading-state
**Location:** register.ejs (no disable on submit), reset_password.ejs (no disable), intake_form.ejs (no), contact.ejs (no), public_case_new.ejs (no), doctor_signup.ejs (no), patient_review_form.ejs (no), order_payment.ejs (no)
**Description:** Only `forgot_password.ejs:96-106` implements the disable+spinner pattern. Every other form lets users double-submit (esp. on slow connections). With CSRF protection enabled, double-submit usually 403s — confusing failure.
**Impact:** Slow-network users (likely AR/Egyptian rural) double-submit and see CSRF errors.
**Fix scope:** medium (add a global disable-on-submit hook to the footer.ejs JS, like `data-confirm` is)
**Verification:** VERIFIED-code

### P2-UI-37 — Doctor case queue does not refresh without full page reload
**Severity:** P2
**Category:** loading-state / UX
**Location:** /Users/ziadelwahsh/tashkheesa-portal/src/views/portal_doctor_dashboard.ejs, portal_doctor_cases.ejs
**Description:** No `setInterval`, `EventSource`, or `fetch` polling for new cases or SLA tick updates. Doctor must manually refresh to see SLA timer move below the 24h threshold or a new assignment.
**Impact:** Doctors miss new assignments; SLA dot color stale.
**Fix scope:** medium (add polling or SSE for queue updates)
**Verification:** VERIFIED-code

### P2-UI-38 — File upload has no progress indicator on `patient_new_case.ejs` Step 2
**Severity:** P2
**Category:** loading-state
**Location:** /Users/ziadelwahsh/tashkheesa-portal/src/views/patient_new_case.ejs:245 (uploads up to 500 MB)
**Description:** Page advertises "up to 500 MB each" but the drop-zone implementation (Uploadcare-managed) handles its own progress UI; if Uploadcare is misconfigured (`uploaderConfigured=false` path), the manual fallback shows nothing.
**Impact:** Patient uploading a 200MB DICOM ZIP sees no indication that anything is happening; many will refresh and lose state.
**Fix scope:** medium
**Verification:** NEEDS-VERIFICATION (depends on Uploadcare widget behavior)

---

## Error states

### P1-UI-39 — Generic `<%= error %>` echo without field context
**Severity:** P1
**Category:** error-state
**Location:** register.ejs:13, reset_password.ejs:22, intake_form.ejs:36, public_case_new.ejs:24, doctor_signup.ejs (uses `_err`)
**Description:** Server emits a generic error string; the view shows it above the form with no indication of which field failed (no `aria-invalid`, no inline message under field). Patients hitting validation errors must reread the whole form.
**Impact:** Frustrating field-by-field debugging UX.
**Fix scope:** medium (return errors keyed by field; add `aria-invalid` and inline `<small>`)
**Verification:** VERIFIED-code

### P2-UI-40 — Legacy `error.ejs` and modern `patient_500.ejs` co-exist; `error.ejs` is English-only with `history.back()` button
**Severity:** P2
**Category:** error-state / i18n
**Location:** /Users/ziadelwahsh/tashkheesa-portal/src/views/error.ejs:24-35, /Users/ziadelwahsh/tashkheesa-portal/src/views/patient_500.ejs (good bilingual version)
**Description:** `error.ejs` honors `<html lang="<%= lang %>">` but body content ("An unexpected error occurred.", "Go Back", "Home", "Error ID:") is English-only. `patient_500.ejs` is bilingual and well-designed — but the global error handler may still render `error.ejs` for non-patient-context routes (e.g., admin/doctor flows under exception). Need to verify which is actually rendered for /admin/* errors.
**Impact:** Admin/doctor 500s show English-only legacy page.
**Fix scope:** small
**Verification:** NEEDS-VERIFICATION (route-handler decision)

### P2-UI-41 — `404.ejs` is English-only and rendered globally
**Severity:** P2
**Category:** error-state / i18n
**Location:** /Users/ziadelwahsh/tashkheesa-portal/src/views/404.ejs:5-7
**Description:** "Page Not Found", "The page you're looking for doesn't exist or has been moved.", "Go Home" — all English. `<html dir>` flips correctly via auth-layout but copy doesn't. `patient_404.ejs` is bilingual, but only renders when the request is patient-context (per its docstring). Doctor / admin / public 404s land on the English page.
**Impact:** Doctor or AR public visitor hitting a missing URL sees English-only 404.
**Fix scope:** small
**Verification:** VERIFIED-code

---

## Dead UI / debt

### P1-UI-42 — Seventeen `.bak` view files in the repo
**Severity:** P1
**Category:** debt
**Location:**
- src/views/doctor_alerts.ejs.bak
- src/views/portal_doctor_profile.ejs.bak
- src/views/doctor_case_intelligence.ejs.bak
- src/views/patient_referrals.ejs.bak
- src/views/patient_reviews.ejs.bak
- src/views/doctor_analytics.ejs.bak
- src/views/patient_appointments_list.ejs.bak
- src/views/patient_prescription_detail.ejs.bak
- src/views/doctor_prescriptions_list.ejs.bak
- src/views/patient_review_form.ejs.bak
- src/views/patient_records.ejs.bak
- src/views/patient_alerts.ejs.bak
- src/views/portal_doctor_guide.ejs.bak
- src/views/patient_prescriptions.ejs.bak
- src/views/doctor_appointments.ejs.bak
- src/views/doctor_prescribe.ejs.bak
- src/views/layouts/portal.ejs.bak
**Description:** Seventeen `.bak` files across the views tree. Express EJS only renders `*.ejs` so these are inert at runtime, but they confuse search (`grep` returns hits inside `.bak`), increase repo bloat, and risk being accidentally loaded if a `.ejs` rename copies a stale `.bak`.
**Impact:** Maintainer cognitive load + grep/PR-diff noise.
**Fix scope:** small (delete after final v2 sweep is approved)
**Verification:** VERIFIED-code

### P0-UI-43 — `/order/start` hard-redirects to `coming_soon.ejs`
**Severity:** P0 (already known per brief)
**Category:** debt / golden-flow
**Location:** /Users/ziadelwahsh/tashkheesa-portal/src/routes/order_flow.js:115-119
**Description:** The original order start route is commented out (lines 121-131); production traffic always lands on `coming_soon.ejs`. Combined with UI-6, this means *every* patient who clicks any "Start a case" link from `/services` (lines 16-20 of services.ejs CTAs) hits an English-only marketing page that can't onboard them.
**Impact:** No revenue-bearing patient flow exists from the marketing surface today.
**Fix scope:** small (uncomment original block) BUT depends on the new-case-wizard at `/patient/new-case` being the actual launch flow; verify the CTA links are pointing at the right URL.
**Verification:** VERIFIED-code

### P2-UI-44 — Footer "Doctors" nav link points to `/about`
**Severity:** P2
**Category:** debt / IA
**Location:** /Users/ziadelwahsh/tashkheesa-portal/src/views/index.ejs:79
**Description:** `<a href="/about">Doctors</a>` — the "Doctors" nav link goes to /about (which is the company about page). No /doctors public listing exists.
**Impact:** Patients can't browse doctors; "Doctors" link is dishonest.
**Fix scope:** small
**Verification:** VERIFIED-code

### P3-UI-45 — `_app_waitlist_form.ejs` partial referenced from `app_landing.ejs` but is English-only
**Severity:** P3
**Category:** i18n
**Location:** /Users/ziadelwahsh/tashkheesa-portal/src/views/_app_waitlist_form.ejs (no i18n markers; per check)
**Description:** App-waitlist form (referenced by `app_landing.ejs`) is English-only. App landing has a hand-rendered AR variant copy block but the inline form doesn't.
**Fix scope:** small
**Verification:** VERIFIED-code

---

## Form UX

### P1-UI-46 — Phone field has no country-code picker, no E.164 normalization
**Severity:** P1
**Category:** form-ux
**Location:** /Users/ziadelwahsh/tashkheesa-portal/src/views/register.ejs:32; patient_onboarding.ejs:122; public_case_new.ejs:43-45
**Description:** Phone is `<input type="tel" pattern="^\+?[0-9 \-()]{8,}$">` with placeholder `+201012345678`. Patients type local-format `01012345678` and pass HTML5 validation (8+ digits) but the WhatsApp send-side will normalize differently. No country-code dropdown, no automatic prefix on country select. `patient_onboarding.ejs` separately does `dir="ltr"` on the input (good) but lacks normalization.
**Impact:** WhatsApp delivery failures; payment links to wrong country normalization; AR users typing `+٢٠` Arabic-Indic digits will fail.
**Fix scope:** medium (add libphonenumber-style picker, accept Eastern-Arabic digits, normalize to E.164 server-side)
**Verification:** VERIFIED-code

### P2-UI-47 — National ID never collected; no length/format validation on identity fields
**Severity:** P2
**Category:** form-ux
**Location:** intake_form.ejs, register.ejs, public_case_new.ejs
**Description:** None of the patient-onboarding forms ask for or validate Egyptian National ID (14 digits) — likely a deliberate product choice but worth flagging if KYC is needed for medical-record release.
**Impact:** Out of scope or future; flag to product.
**Fix scope:** medium
**Verification:** INFERRED

### P2-UI-48 — Date pickers use native `<input type="date">` without locale hint
**Severity:** P2
**Category:** form-ux / rtl / i18n
**Location:** doctor_appointments.ejs (filters), appointment_booking.ejs (slot selection)
**Description:** Native `type="date"` rendering follows browser locale (system-set), not the page lang. AR Egyptian users on EN-locale Chrome get Western date pickers; can be confusing for staff workstations.
**Fix scope:** medium (custom calendar with `lang`-driven names) — low priority for v1
**Verification:** INFERRED

### P3-UI-49 — Required-field indicator inconsistent
**Severity:** P3
**Category:** form-ux
**Location:** register.ejs:31 uses `<span style="color:#e53e3e;">*</span>`; coming_soon.ejs:292/296 uses literal `*` in the label string; intake_form.ejs uses `required` attribute only (no asterisk); contact.ejs no asterisk.
**Description:** Three different required-field conventions across forms.
**Impact:** Consistency / polish.
**Fix scope:** small
**Verification:** VERIFIED-code

### P2-UI-50 — File-upload size limit visible only on patient new-case Step 2
**Severity:** P2
**Category:** form-ux
**Location:** patient_new_case.ejs:245 ("up to 500 MB each"); order_upload.ejs (no size hint visible)
**Description:** `order_upload.ejs` (the alternative upload flow accessible via `/order/:token/upload` for guest sessions) has no size limit hint. `patient_order_upload.ejs:143` shows the hint correctly.
**Fix scope:** small
**Verification:** VERIFIED-code

---

## Visual debt / consistency

### P3-UI-51 — Multiple `<h1>` per page on marketing tree
**Severity:** P3
**Category:** debt / SEO
**Location:** index.ejs has only 1 `<h1>` (good); about.ejs and services.ejs have 1 each. (Quick `grep -c "<h1"` showed 1 each.) No multi-h1 issue at top of funnel.
**Description:** Spot-check passed; not flagged elsewhere because grep is narrow. NEEDS-VERIFICATION on inner partials.
**Fix scope:** —
**Verification:** NEEDS-VERIFICATION

### P2-UI-52 — Hex color tokens scattered across views (no design-token discipline)
**Severity:** P2
**Category:** debt
**Location:** coming_soon.ejs uses `#1f2937`, `#2563eb`, `#1d4ed8`, `#10b981`, `#e5e7eb`; about/services/contact reference `#0066CC`, `#1e3a8a`; patient v2 uses `var(--ink)`, `var(--accent)`, `var(--brass)` (good).
**Description:** Patient v2 chrome has design tokens (`var(--ink)`, `var(--primary)`, etc.). Marketing tree (index/about/services/contact/coming_soon) hardcodes 8+ different blues without tokens. Two button styles for the same "primary" action (`.btn-primary` vs `.btn-primary-link` vs `.submit-btn`).
**Impact:** Brand drift across funnel; future redesign costly.
**Fix scope:** large
**Verification:** VERIFIED-code

### P3-UI-53 — Two button styles for the same "Submit Interest" action across pages
**Severity:** P3
**Category:** debt
**Location:** coming_soon.ejs (`.submit-btn` gradient), contact.ejs (`.btn-primary-link`), register.ejs (`.btn .btn-primary .btn-full`), patient_new_case.ejs (`.p-btn .p-btn--primary`).
**Description:** Four primary CTAs each have a different class. Leakage of v1 (`.btn`), v2 patient (`.p-btn`), and bespoke (`.submit-btn`).
**Fix scope:** medium
**Verification:** VERIFIED-code

---

## Patient walkthrough

### P2-UI-54 — `patient_walkthrough.ejs` is a help page, not auto-shown for first-time patients
**Severity:** P2
**Category:** UX / onboarding
**Location:** /Users/ziadelwahsh/tashkheesa-portal/src/routes/help.js:23-31 (only handlers); no first-time-patient gate found
**Description:** The walkthrough is reachable only via `/help/patient-walkthrough` and `/help/ar/patient-walkthrough`. There is no logic in patient.js or middleware that auto-redirects first-time patients to it. A patient who logs in and goes to `/dashboard` lands directly on `patient_dashboard.ejs` with no guided tour. No `seen_walkthrough` flag exists on `users` table (verified via routes search).
**Impact:** First-time patients get no orientation; if intended to be promoted, it isn't.
**Fix scope:** medium (add a one-time banner pointing to walkthrough; add `users.seen_walkthrough` cookie/flag)
**Verification:** VERIFIED-code

### P2-UI-55 — New-case wizard shows progress (good) but Step labels can drift between EN and AR digits
**Severity:** P3
**Category:** UX
**Location:** /Users/ziadelwahsh/tashkheesa-portal/src/views/patient_new_case.ejs:48-57, 88-92
**Description:** `progress-track` partial is included with `step: __step - 1`, `total: 5`, `labels: stepLabels` — verified the labels are bilingual. Good. AR title uses Arabic digits via interpolation (`'الخطوة ' + __step + ' من 5'`), so step numbers come out as Western digits in AR mode; small visual inconsistency with `'٧٢ ساعة'` SLA labels.
**Impact:** Minor cosmetic.
**Fix scope:** small
**Verification:** VERIFIED-code

---

## Bilingual cookie / lang persistence

### P2-UI-56 — Lang cookie persists; users.lang persisted only for patients
**Severity:** P2 (recorded as positive; partial finding)
**Category:** i18n
**Location:** /Users/ziadelwahsh/tashkheesa-portal/src/routes/lang.js:33-114
**Description:** `/lang/:code` writes a 1-year cookie (httpOnly:false), updates `req.session.lang`, and persists to `users.lang` **only for patients** (line 50). Doctor/admin language preferences never persist to DB.
**Impact:** Doctors who toggle to AR mid-session lose the preference on re-login; doctor-targeted notifications fall back to default.
**Fix scope:** small
**Verification:** VERIFIED-code

### P3-UI-57 — Email language tracked separately from session lang
**Severity:** P3
**Category:** i18n / notification
**Location:** /Users/ziadelwahsh/tashkheesa-portal/src/notification_worker.js:80, 174
**Description:** Worker uses `user.lang` from DB (good — patient `users.lang` updated by lang.js). Doctor notification language uses fallback `user.lang === 'ar' ? 'ar' : 'en_US'` — correctly persists. So patients toggling lang mid-session immediately get notifications in the right language.
**Verification:** VERIFIED-code

---

## Doctor portal UX

### P2-UI-58 — Doctor queue / cases list is NOT auto-refreshable; full reload required
**Severity:** P2
**Category:** UX / loading-state
**Location:** /Users/ziadelwahsh/tashkheesa-portal/src/views/portal_doctor_dashboard.ejs (only one `fetch` — `/portal/doctor/onboarding/dismiss`); portal_doctor_cases.ejs (zero `fetch`)
**Description:** Doctor must manually F5 or click reload-page button to see new cases. Bell partial (`partials/doctor/bell.ejs`) probably polls — needs verification — but the queue card on dashboard does not.
**Impact:** Doctors miss SLA-critical assignments until they refresh.
**Fix scope:** medium
**Verification:** VERIFIED-code

### P3-UI-59 — Doctor bell present in topbar (positive)
**Severity:** P3 (positive finding)
**Category:** —
**Location:** /Users/ziadelwahsh/tashkheesa-portal/src/views/partials/doctor/topbar.ejs:45 includes `bell` partial
**Description:** Doctor topbar includes the bell partial; verified.
**Verification:** VERIFIED-code

### P2-UI-60 — Doctor earnings has clean empty state (positive)
**Severity:** P3 (positive finding)
**Category:** empty-state
**Location:** /Users/ziadelwahsh/tashkheesa-portal/src/views/portal_doctor_earnings.ejs:30-46
**Description:** Bilingual empty state, CTA pointing to "View available cases", visible icon, friendly copy. Reference design.
**Verification:** VERIFIED-code

### P2-UI-61 — Doctor Sidebar `analytics` link cluttered with `.bak` parallel; risk of stale view rendering
**Severity:** P2
**Category:** debt
**Location:** /Users/ziadelwahsh/tashkheesa-portal/src/views/doctor_analytics.ejs vs doctor_analytics.ejs.bak
**Description:** Both files exist with similar names. Render code does `res.render('doctor_analytics')` (no extension) so `.bak` is inert, but if a contributor renames the live file accidentally, `.bak` becomes the source.
**Verification:** VERIFIED-code

---

## Per-view lang attr / dir verification

### P2-UI-62 — `<html lang>` set dynamically in layouts, but `index.ejs` and `ops-login.ejs` are full HTML and hardcode `lang="en"`
**Severity:** P2
**Category:** i18n / a11y
**Location:** /Users/ziadelwahsh/tashkheesa-portal/src/views/index.ejs:2, /Users/ziadelwahsh/tashkheesa-portal/src/views/ops-login.ejs:2
**Description:** Two views render their own `<html>` (don't use a layout) and hardcode `lang="en"`. Marketing index is the worse of the two (P0 — see UI-1/UI-8). Ops is internal but still wrong for AR-speaking ops staff.
**Fix scope:** small
**Verification:** VERIFIED-code

### P3-UI-63 — `error.ejs` (legacy) honors `<html lang>` but body is English-only
**Severity:** P3 (covered by UI-40)
**Category:** i18n
**Location:** /Users/ziadelwahsh/tashkheesa-portal/src/views/error.ejs:2-37
**Description:** See UI-40.
**Verification:** VERIFIED-code

---

## Cross-cutting summary

- **English-only views (33)** include critical funnel pages: `index`, `about`, `services`, `contact`, all four legal pages, `coming_soon`, and `404`. This is the primary launch blocker for AR users.
- **Two parallel i18n systems** with the JSON-file system being dead code is a maintainability landmine.
- **17 `.bak` files** indicate a stalled v2 migration — recommend deleting before launch.
- **Skip-to-content** absent everywhere — quick a11y win.
- **No country-code phone picker** — risk to WhatsApp delivery and patient acquisition for non-EG numbers.
- **Forms don't disable on submit** (except forgot_password) — risk of double-submit + CSRF errors.
- **Doctor queue doesn't auto-refresh** — risk of missed SLA action by doctors.
- **`/order/start` hard-redirects to English-only `coming_soon.ejs`** — until reverted, no AR funnel exists.

Highest-leverage fixes for launch:
1. Translate `index.ejs`, `services.ejs`, `coming_soon.ejs` (UI-1, UI-3, UI-6).
2. Re-enable original `/order/start` (UI-43).
3. Fix `messages.ejs` patient subtitle (UI-10) — small but visible bug.
4. Add disable-on-submit to all forms (UI-36).
5. Replace inline `border-left:` with `border-inline-start` on patient cards (UI-18).
6. Decide one i18n system; delete the other (UI-13).
7. Delete `.bak` files (UI-42).
8. Add skip-to-content link to layouts (UI-26).


---

# Section 10 — Performance audit

# Performance Audit — 2026-05-06

Stack: Express 4 + Postgres (Supabase pooler — PgBouncer) on Render. Audit
focused on pool tuning, query cost, N+1, transaction scope, static-asset
delivery, view cache, and bundle bloat. Prior P0: pg pool saturation during
SLA sweep (long-running SELECTs starve request handlers).

---

## A. PG pool config dump (`src/pg.js`)

| Setting                   | Value (default)        | Env override                   | Notes |
|---------------------------|------------------------|--------------------------------|-------|
| `max`                     | **10**                 | `PG_POOL_MAX`                  | Single-instance assumption baked into the comment block. |
| `idleTimeoutMillis`       | **30 000 ms** (30 s)   | `PG_POOL_IDLE_TIMEOUT_MS`      | Aggressive — pgbouncer transaction-mode is fine recycling, but cold-starts a new Postgres backend each cycle. |
| `connectionTimeoutMillis` | **15 000 ms** (15 s)   | `PG_POOL_CONNECT_TIMEOUT_MS`   | Recently raised from 5s → 15s to dampen SLA-sweep timeouts. Hides the symptom. |
| `statement_timeout`       | **(NOT SET)**          | —                              | No upper bound on query duration — single runaway can hold a slot indefinitely. |
| `query_timeout`           | **(NOT SET)**          | —                              | Same problem at the pg client level. |
| `ssl`                     | `{rejectUnauthorized: false}` (unless `PG_SSL=false`) | `PG_SSL` | OK for Supabase. |
| pg-boss connection        | `DATABASE_URL_DIRECT \|\| DATABASE_URL` (`src/job_queue.js:14`) | `DATABASE_URL_DIRECT` | Code prefers a direct (port 5432) URL but **silently falls back to the pooled URL** if `DATABASE_URL_DIRECT` is unset — pg-boss on PgBouncer transaction-mode will misbehave (advisory locks, LISTEN/NOTIFY). |

Supabase Free plan caps client connections at 15 per project (per the comment).
With `max=10` plus pg-boss's own pool against the same URL (when
`DATABASE_URL_DIRECT` is missing) plus Supabase internal connections, a
**second Render instance** would push us past the cap immediately.

---

## B. Largest static assets (>100 KB)

| Path | Size | Served via |
|------|------|------------|
| `public/assets/tashkheesa-logo.png` | **1.48 MB** | `/assets` (`server.js:180`) |
| `public/assets/lab_pathology.png` | **1.19 MB** | `/assets` |
| `public/assets/imaging.png` | **1.12 MB** | `/assets` |
| `public/assets/tashkheesa-logo.png1.png` | **1.04 MB** | `/assets` (also a stray dup) |
| `public/assets/eeg_emg.png` | 228 KB | `/assets` |
| `public/assets/pet_oncology.png` | 228 KB | `/assets` |
| `public/assets/ultrasound.png` | 131 KB | `/assets` |
| `public/assets/ecg.png` | 130 KB | `/assets` |
| `public/assets/histo_report.png` | 126 KB | `/assets` |
| `public/assets/genetic_testing.png` | 124 KB | `/assets` |
| `public/styles.css` | **124 KB** | `/styles.css` |
| `public/assets/chest_xray.png` | 119 KB | `/assets` |
| `public/assets/1.png` | 106 KB | `/assets` |
| `public/css/doctor-portal-v2.css` | **56 KB** | `/css` |
| `public/css/doctor-portal-v2.css.bak` | 46 KB | `/css` (`.bak` shipped to clients) |
| `public/css/doctor-prescribe.css` | 42 KB | `/css` |
| `public/css/admin-styles.css` | 38 KB | `/css` |
| `public/js/image-annotator.js` | 30 KB | `/js` |

`public/js/` and `public/vendor/` contain no >100 KB files (max is `image-annotator.js` at 30 KB and `lucide.min.js` at 5.7 KB).

The 6 `.bak` files in `public/css/` (and one `doctor-analytics.css.bak`) are
served by `express.static('/css')` — they ship to anyone who types the URL.

---

## C. Findings

### P0-PERF-1 — `markCasePaid` transaction nests pool re-acquires recursively
**Severity:** P0 | **Category:** pool | **Location:** `src/case_lifecycle.js:1331-1396` | **Description:** `markCasePaid` opens a transaction with `withTransaction(client => …)` and does `SELECT … FOR UPDATE`, but every helper called inside (`transitionCase` line 1363, `execute(UPDATE notifications)` line 1372, `logCaseEvent` lines 1383-1384, `triggerNotification` line 1385, `dispatchSlaReminders` line 1390, `getCase` line 1395) ignores the `client` argument and goes through the module-level `pool.query` / `execute` / `queryOne`. While one connection holds a `FOR UPDATE` row-lock, the same code path tries to acquire **5–8 additional pool connections** sequentially. With `max=10` and 2 concurrent payment confirmations, the pool is saturated and the SLA sweep hangs on the connect timeout. | **Impact:** Direct cause of the prior-foundational pool-saturation bug during payment bursts; also makes the row-lock useless because the writes happen outside the transaction. | **Fix scope:** large (thread `client` through `transitionCase`, `logCaseEvent`, `updateCase`, `getCase`, the unpaid-reminder UPDATE, and `triggerNotification`; or move the side-effects out of the transaction). | **Verification:** VERIFIED-code

### P0-PERF-2 — pg-boss pool falls back to PgBouncer transaction-mode URL silently
**Severity:** P0 | **Category:** pool | **Location:** `src/job_queue.js:14` | **Description:** `var connectionString = process.env.DATABASE_URL_DIRECT || process.env.DATABASE_URL;` — if `DATABASE_URL_DIRECT` is not set in Render env, pg-boss connects through the same PgBouncer transaction-mode pooler as the request path. pg-boss requires session-mode behavior (advisory locks for cron singletons, `LISTEN/NOTIFY`, prepared statements). Under PgBouncer txn-mode the SLA sweep cron singleton can double-fire across instances and `boss.work()` long-poll connections sit on pooler slots. | **Impact:** Loses cross-instance singleton guarantee for the SLA sweep (the entire reason it was migrated to pg-boss); plus pg-boss long-poll connections eat the same 15-slot Supabase budget. | **Fix scope:** small (require `DATABASE_URL_DIRECT`; fail-fast in `bootCheck.js` if missing) | **Verification:** VERIFIED-code

### P0-PERF-3 — No `statement_timeout` on the request-path pool
**Severity:** P0 | **Category:** pool | **Location:** `src/pg.js:42-48` | **Description:** Pool config sets neither `statement_timeout` (server-side) nor `query_timeout` (client-side). A single accidentally-unbounded query (e.g. the superadmin `additional_files` CTE in `routes/superadmin.js:914-960` that scans `order_events` with 10× `LOWER(label) LIKE '%…%'` patterns) can hold a connection for minutes, multiplied by retries. This is the proximal cause of the SLA-sweep timeouts that drove the `connectionTimeoutMillis 5s→15s` increase: the fix masked the symptom rather than capping the slow query. | **Impact:** Any slow query starves the pool until it finishes; raising `connectionTimeoutMillis` just lengthens how long callers block waiting. | **Fix scope:** small (add `statement_timeout: '30s'` via `options` connection param, and a per-pool `query_timeout: 30000`; carve a higher value for the SLA sweep client) | **Verification:** VERIFIED-code

### P1-PERF-4 — SLA reminder transaction in `server.js` holds a connection through a `for await` loop with external side-effects
**Severity:** P1 | **Category:** pool | **Location:** `src/server.js:1035-1098` | **Description:** Two adjacent `withTransaction` blocks each (a) `SELECT` all in-flight orders into memory, (b) iterate them with `for (var i …)` issuing per-row `client.query('UPDATE …')`, and (c) call `queueNotification(…)` and `issueBreachRefundSafe(…)` from inside the loop. `queueNotification` issues its own `pool.query` (not on `client`), and `issueBreachRefundSafe` may make external HTTP calls (Paymob refund). The transaction connection is held for the entire sweep duration. | **Impact:** During a breach burst the SLA-sweep transaction can hold a slot for 10s+ while issuing pool queries from inside it (recursive pool acquire), repeating P0-PERF-1 at the worker level. | **Fix scope:** medium (split into a `SELECT` outside the txn, then per-order short txns; move `issueBreachRefundSafe` outside the txn) | **Verification:** VERIFIED-code

### P1-PERF-5 — Admin dashboard issues 8 sequential COUNT queries
**Severity:** P1 | **Category:** query | **Location:** `src/routes/admin.js:55-79` (`getAdminDashboardStats`) | **Description:** `getAdminDashboardStats` does 8 sequential `await queryOne("SELECT COUNT(1) … status = 'X'")` calls (totalDoctors, activeDoctors, openOrders, newOrders, acceptedOrders, inReviewOrders, completedOrders, breachedOrders). Each is a fresh roundtrip and a fresh pool acquire. None use a covering index — they all do `LOWER(COALESCE(status, ''))` which is **not indexable** by `idx_orders_status`. The "breached" check uses `LIKE '%breach%'` (full table scan). | **Impact:** Admin dashboard hits 8 slot-waits per page-load; in a saturated pool that's 8× the queue depth. | **Fix scope:** small (collapse to one query: `SELECT COUNT(*) FILTER (WHERE LOWER(status)=…) AS new_orders, … FROM orders`) | **Verification:** VERIFIED-code

### P1-PERF-6 — Doctor dashboard issues ~10 sequential queries (no batching)
**Severity:** P1 | **Category:** query | **Location:** `src/routes/doctor.js:160-228` | **Description:** Doctor dashboard handler awaits in series: `buildPortalCasesUnassigned`, `countPortalCasesUnassigned`, `buildPortalCases(reviewStatuses)`, `countPortalCasesByStatuses(reviewStatuses)`, `buildPortalCases(completedStatuses)`, `countPortalCasesByStatuses(completedStatuses)`, streak query, month-metrics query, priority-queue query, plus the assigned-pending block above. Compare to the cases-list handler at `:776` which **does** batch into `Promise.all([…5 queries])`. | **Impact:** Doctor dashboard TTFB is ~10× one query latency; in a busy pool it's worse because each `await` releases and re-acquires a slot. | **Fix scope:** small (wrap independent queries in a single `Promise.all`) | **Verification:** VERIFIED-code

### P1-PERF-7 — Patient `new-case` Step-3 issues blocking AI calls inside the request handler
**Severity:** P1 | **Category:** query | **Location:** `src/routes/order_flow.js:308-370` | **Description:** Inside the `/patient/new-case/step-3` POST, after persisting files, the handler enters `for (var fi = 0; fi < req.files.length; fi++) { … await validateMedicalImage(f.buffer, …) }` — a **serial loop of Anthropic API calls** during the HTTP request. Each AI call also does an extra `queryOne(SELECT id FROM order_files …)` and an `INSERT INTO file_ai_checks`. With the typical 3–5-file submission this adds 10–25s to the form post and holds a connection (via the per-file queries) the whole time. | **Impact:** TTFB on case submission is 10–30s; the connection is held; pool saturation triggers SLA-sweep timeouts. | **Fix scope:** medium (enqueue an `ai-image-check` pg-boss job per file and return immediately; surface warnings on the next page) | **Verification:** VERIFIED-code

### P1-PERF-8 — `cases_intake` issues `CREATE SEQUENCE IF NOT EXISTS` on every request
**Severity:** P1 | **Category:** query | **Location:** `src/routes/api/cases_intake.js:103` | **Description:** Inside the request transaction: `await client.query('CREATE SEQUENCE IF NOT EXISTS website_intake_seq START 1');` runs DDL on every public POST. DDL takes a transient `AccessExclusiveLock` on the schema namespace and is forbidden under PgBouncer transaction-mode in some configurations. | **Impact:** Public form endpoint triggers DDL → schema lock contention; under load this serializes every public submission. | **Fix scope:** small (move to a one-time migration; use the existing reference-id helper from `case_lifecycle`) | **Verification:** VERIFIED-code

### P1-PERF-9 — Superadmin `additional_files_requests` CTE is a hot full-scan
**Severity:** P1 | **Category:** query | **Location:** `src/routes/superadmin.js:914-960` (and `825-865`) | **Description:** `getPendingAdditionalFilesRequests` runs a CTE over `order_events` with **eight `LOWER(label) LIKE '%…%'` predicates**, plus a correlated subquery (`e1.id = (SELECT e2.id FROM order_events e2 WHERE e2.order_id = e1.order_id ORDER BY e2.at DESC LIMIT 1)`). No index supports `LOWER(label) LIKE '%request%'` — Postgres can only use a `pg_trgm` GIN index for this, and none exists. This runs per superadmin dashboard load. | **Impact:** Each request scans the entire `order_events` table (which grows monotonically — every status change adds a row). Will degrade visibly within a month of launch. | **Fix scope:** medium (write canonical labels to a `is_additional_files_request` column or a small `case_action_requests` table; or add a `pg_trgm` GIN index on `LOWER(label)` as a stopgap) | **Verification:** VERIFIED-code

### P1-PERF-10 — Conversations list uses 3 correlated sub-SELECTs per row
**Severity:** P1 | **Category:** query/n+1 | **Location:** `src/routes/messaging.js:79-99` | **Description:** Messages list handler does `SELECT c.*, … (SELECT content FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_message, (SELECT created_at …) AS last_message_at, (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id AND is_read=false …) AS unread_count FROM conversations c …`. Each conversation row triggers 3 sub-queries — Postgres' planner sometimes inlines them into a `LATERAL` but isn't guaranteed to. | **Impact:** O(N×3) work per page load where N = a user's conversation count. | **Fix scope:** small (replace with a `LATERAL JOIN (… ORDER BY created_at DESC LIMIT 1)` + a `GROUP BY conversation_id` aggregate for unread; or denormalize `last_message_*` onto `conversations`) | **Verification:** VERIFIED-code

### P1-PERF-11 — `/superadmin/exports/orders.csv` materializes the entire orders table in memory
**Severity:** P1 | **Category:** query | **Location:** `src/routes/exports.js:16-39` | **Description:** CSV export does `await queryAll(SELECT … FROM orders … ORDER BY created_at DESC, …)` with **no LIMIT and no streaming**. All rows are buffered into a JS array, then mapped into one giant string, then `res.send`ed. | **Impact:** OOM risk + holds a pool connection for the entire query duration. At 10k orders this is ~5MB of JS heap; at 100k it's the whole heap on a Render starter. | **Fix scope:** medium (use `pg-query-stream` to stream rows directly to `res`; or paginate by `created_at` cursor) | **Verification:** VERIFIED-code

### P1-PERF-12 — No `Cache-Control` on static assets (`/css`, `/js`, `/vendor`, `/assets`)
**Severity:** P1 | **Category:** cache | **Location:** `src/server.js:179-188` | **Description:** Every `express.static(…)` mount is a bare call with no `maxAge`, `immutable`, or `setHeaders` option. Express defaults to `Cache-Control: public, max-age=0` — every page revalidates every CSS/JS/PNG via 304s. The 1.48 MB logo, 1.19 MB lab_pathology.png, etc. are all conditionally re-fetched on every navigation. | **Impact:** Each portal page makes 10-30 conditional GETs for static assets; doubles request count to the Node process. | **Fix scope:** small (`express.static(…, { maxAge: '7d', immutable: true })` for `/vendor` and hashed assets; `'1d'` for `/css` and `/js`) | **Verification:** VERIFIED-code

### P1-PERF-13 — No HTTP compression middleware
**Severity:** P1 | **Category:** cache/bundle | **Location:** `src/middleware.js`, `src/server.js` (no occurrence of `compression`) | **Description:** No `compression()` middleware is mounted. The 124 KB `styles.css`, 56 KB `doctor-portal-v2.css`, and EJS-rendered HTML bodies are all served uncompressed. | **Impact:** ~3-5× wire size for text assets and HTML. | **Fix scope:** small (`npm i compression`; `app.use(compression())` early in `server.js`) | **Verification:** VERIFIED-code

### P1-PERF-14 — Image assets unoptimized — 1.5 MB PNG logo
**Severity:** P1 | **Category:** bundle | **Location:** `public/assets/tashkheesa-logo.png` (1.48 MB), `public/assets/tashkheesa-logo.png1.png` (1.04 MB, accidental duplicate), `public/assets/imaging.png` (1.12 MB), `public/assets/lab_pathology.png` (1.19 MB) | **Description:** 4 PNGs over 1 MB. `tashkheesa-logo.png` is the brand mark — used on every page. There's a brand WebP/SVG-style folder at `public/assets/brand/` already; the unbranded `tashkheesa-logo.png` looks like a legacy upload. | **Impact:** 4 MB of image weight on first paint of any portal page that includes the logo. | **Fix scope:** small (compress to WebP / SVG, drop the `*.png1.png` duplicate, audit which logo path the layouts actually reference) | **Verification:** VERIFIED-code

### P2-PERF-15 — `.bak` CSS files served publicly via `express.static('/css')`
**Severity:** P2 | **Category:** bundle | **Location:** `public/css/*.css.bak` (7 files: `doctor-analytics.css.bak`, `doctor-appointments.css.bak`, `doctor-guide.css.bak`, `doctor-portal-v2.css.bak`, `doctor-profile.css.bak`, `portal-variables.css.bak`) | **Description:** `express.static` doesn't blacklist extensions. Anyone hitting `/css/doctor-portal-v2.css.bak` gets the 46 KB file. Wastes bandwidth and exposes pre-fix CSS to scrapers. | **Impact:** ~140 KB of duplicate dead CSS shipped on demand; minor info disclosure. | **Fix scope:** small (delete the `.bak` files or move them outside `public/`) | **Verification:** VERIFIED-code

### P2-PERF-16 — `express-rate-limit` uses the in-memory store on multi-instance Render
**Severity:** P2 | **Category:** pool/cache | **Location:** `src/middleware.js:77-183` (every `rateLimit({…})` call) | **Description:** All ~10 rate-limiter instances use the default in-memory store. On the second Render instance, each instance keeps its own counters — limits are effectively 2× whatever the config says. The auth limiter (`max: 30 per 15min`) and new-case limiter (`max: 5 per 15min`) are the load-bearing ones. | **Impact:** Brute-force throttle and queue-flood throttle weaken proportionally to instance count. | **Fix scope:** medium (swap to `rate-limit-redis` or `rate-limit-postgres-store` once a shared cache exists) | **Verification:** VERIFIED-code

### P2-PERF-17 — `idleTimeoutMillis: 30s` is aggressive for PgBouncer
**Severity:** P2 | **Category:** pool | **Location:** `src/pg.js:40` | **Description:** 30s idle timeout closes pooled connections quickly. Each reconnect to PgBouncer is cheap, but the **server-side Postgres backend** PgBouncer creates is more expensive (auth + initial query). Steady-state low traffic between SLA sweeps means every sweep starts cold. | **Impact:** Adds ~50-200ms cold-start latency per sweep; minor in normal operation but compounds with the 15s connect timeout. | **Fix scope:** small (raise to 60s or align with pgbouncer `server_idle_timeout`) | **Verification:** INFERRED

### P2-PERF-18 — Patient new-case Step-3 reads `specialties` + `services` on every render even with no selection
**Severity:** P2 | **Category:** query | **Location:** `src/routes/order_flow.js:148-155` and `:178-186`, `src/routes/patient.js:1230-1262` | **Description:** Every Step-3 render runs `SELECT … FROM specialties … ORDER BY name ASC` plus a join to `services` with a `service_regional_prices` LEFT JOIN. The data changes maybe once a week. Same query is duplicated across 5 callers in `order_flow.js` / `patient.js`. | **Impact:** 2 fresh queries on every Step-3 GET. | **Fix scope:** small (memoize specialties/services in-process for ~60s; the existing `safeAll` helper is already present) | **Verification:** VERIFIED-code

### P2-PERF-19 — `unpaid_reminder` worker iterates 200 rows in a serial `for await` loop
**Severity:** P2 | **Category:** pool/n+1 | **Location:** `src/case_lifecycle.js:457-510` (`dispatchUnpaidCaseReminders`, branch with no `caseIdOrRow`) | **Description:** Bulk dispatch path: `for (const r of rows) { await dispatchUnpaidCaseReminders(r, { force }); }` over up to 200 rows, where each call issues several queries (dedupe check + queueNotification insert). Same pattern in `dispatchSlaReminders` at `:384-387`. | **Impact:** 200 rows × ~3 queries = 600 sequential pool acquires; same connection-recycle pattern as P0-PERF-1 inside a long-running worker. | **Fix scope:** medium (batch dedupe checks via `WHERE dedupe_key = ANY($1)`; bulk insert notifications) | **Verification:** VERIFIED-code

### P2-PERF-20 — `delete account` GDPR endpoint is 9 sequential DELETEs
**Severity:** P2 | **Category:** query | **Location:** `src/routes/api/profile.js:127-157` | **Description:** Account-delete iterates a 9-table list with serial `await safeRun(…)` per table (some use a subquery against `orders WHERE patient_id = $1`). Holds the request thread for the duration; not in a transaction so a partial failure leaves orphan rows. | **Impact:** Slow + non-atomic deletion. Low traffic so impact is minimal — but the partial-failure case is a data-integrity bug, not just perf. | **Fix scope:** small (wrap in `withTransaction` with `client` threaded; add `ON DELETE CASCADE` migration) | **Verification:** VERIFIED-code

### P2-PERF-21 — No functional index on `LOWER(orders.status)` despite ubiquitous filter pattern
**Severity:** P2 | **Category:** query | **Location:** `src/migrations/003_indexes.sql` (only plain `idx_orders_status`); query callers everywhere use `LOWER(COALESCE(status, ''))` (`routes/admin.js:61-73`, `case_sla_worker.js:174`, `routes/doctor.js:3148`, etc.) | **Description:** The codebase canonicalized status filters as `LOWER(COALESCE(status, '')) = '…'` but the supporting index is `CREATE INDEX idx_orders_status ON orders(status)` — non-functional. Postgres can't use a btree on `status` for `LOWER(status)`. All these queries are seq-scans on the orders table. | **Impact:** Once `orders` grows past ~50k rows the SLA candidate fetch and dashboard counts move from index scans to seq scans. | **Fix scope:** small (`CREATE INDEX idx_orders_lower_status ON orders(LOWER(COALESCE(status, '')))` migration) | **Verification:** VERIFIED-code

### P2-PERF-22 — `orders.updated_at` not indexed despite being the canonical sort key
**Severity:** P2 | **Category:** query | **Location:** Index list at `src/migrations/003_indexes.sql`; usage at `routes/doctor.js:3150`, `routes/patient.js:1003`, `routes/patient.js:988` | **Description:** Several user-facing list queries `ORDER BY COALESCE(o.updated_at, o.created_at) DESC LIMIT N`. There's `idx_orders_created_at` but no `idx_orders_updated_at`. The COALESCE further prevents using either index for the sort. | **Impact:** Doctor cases list and patient orders list will move to in-memory sort once the orders table grows. | **Fix scope:** small (add `idx_orders_updated_at`; consider a generated column `effective_updated_at = COALESCE(updated_at, created_at)` with an index) | **Verification:** VERIFIED-code

### P3-PERF-23 — `view cache` not explicitly enabled
**Severity:** P3 | **Category:** cache | **Location:** `src/server.js:171-172` | **Description:** EJS view engine is registered with no explicit `app.set('view cache', true)`. Express auto-enables view cache when `NODE_ENV=production`, so this is fine **iff** `NODE_ENV` is set on Render (verified empirically by checking `bootCheck.js` which references `MODE` from `process.env.NODE_ENV`). If `NODE_ENV` is `staging` or unset, every render reads + recompiles the EJS file from disk. | **Impact:** ~5-15ms per render hit on cold cache; multiplied across all portal pages. | **Fix scope:** small (`app.set('view cache', MODE !== 'development');` explicit) | **Verification:** NEEDS-VERIFICATION (need to confirm Render's `NODE_ENV` value)

### P3-PERF-24 — `cases_intake.js:55` uses raw `pool.connect()` instead of `withTransaction`
**Severity:** P3 | **Category:** pool | **Location:** `src/routes/api/cases_intake.js:55-141` | **Description:** Uses `const client = await pool.connect()` with a manual `try/catch/finally { client.release() }` block. The `release()` is in the `finally` so it's correct — but the pattern duplicates `withTransaction` in `pg.js`. Also: the `ROLLBACK` on the catch path is wrapped in `try { … } catch (_) {}` — a `ROLLBACK` failure here can leak the connection in a broken state until idle timeout reaps it. | **Impact:** Minor — the `release()` will recycle even after a failed `ROLLBACK`. Still, code duplication risks future bugs. | **Fix scope:** small (replace with `withTransaction(async (client) => { … })`) | **Verification:** VERIFIED-code

### P3-PERF-25 — `apple-touch-icon.png` (33 KB) and `favicon-192.png` (37 KB) served from disk on every request
**Severity:** P3 | **Category:** cache | **Location:** Implicit via `/site` static (`server.js:179`) and direct `/favicon.*` mounts | **Description:** Browsers fetch `apple-touch-icon.png` on first visit per origin; without `Cache-Control` headers (P1-PERF-12) they revalidate. Same for `favicon-192.png`. | **Impact:** Negligible per request, but combines with P1-PERF-12 to inflate request count. | **Fix scope:** small (include in the `Cache-Control` mass-fix from P1-PERF-12 with a 30d max-age) | **Verification:** VERIFIED-code

---

## Quick wins (do these first)

1. **P0-PERF-1** thread `client` through `markCasePaid`'s side effects — direct cause of pool starvation.
2. **P0-PERF-2** require `DATABASE_URL_DIRECT` for pg-boss.
3. **P0-PERF-3** add `statement_timeout: '30s'` to the pool.
4. **P1-PERF-12** + **P1-PERF-13** add `Cache-Control` and `compression()` — one afternoon, instant TTFB win.
5. **P1-PERF-5** + **P1-PERF-6** collapse admin/doctor dashboard COUNTs into single `Promise.all` or single CTE.
6. **P2-PERF-15** delete `public/css/*.bak`.


---

# Section 11 — Config + deploy audit

# Pre-launch Audit — Config & Deploy
**Date:** 2026-05-06 | **Scope:** env vars, boot validation, MODE/NODE_ENV gates, secrets, deploy config

---

## Env-var cross-reference table

Sources: `grep -rohE 'process\.env\.[A-Za-z_][A-Za-z0-9_]*' src/` vs documented vars in `/.env.example`.

| Env var | In code? | In .env.example? | Required? | Aliased? |
|---|---|---|---|---|
| ADDON_SYSTEM_V2 | yes | **NO** | no (default false) | no |
| ADMIN_PHONE | yes (critical-alert.js) | yes | no (silent disable) | no |
| AGENT_NAME | yes (recipientGuard) | **NO** | no | no |
| ALLOW_PRIMARY_IN_DEV | yes (bootCheck) | yes | only with primary in dev | no |
| ANTHROPIC_API_KEY | yes | yes | **YES (server.js:52 fatal)** | no |
| APP_URL | yes | yes | no (alias of BASE_URL) | yes (BASE_URL \|\| APP_URL) |
| BASE_URL | yes | yes | no (default '') | yes (BASE_URL \|\| APP_URL) |
| BASIC_AUTH_PASS | yes | yes | yes in staging/prod | yes (\|\| STAGING_PASS) |
| BASIC_AUTH_USER | yes | yes | yes in staging/prod | yes (\|\| STAGING_USER) |
| BRAND_NAME | yes | **NO** | no (default 'Tashkheesa') | no |
| BUSINESS_ADDRESS | yes | yes | no | no |
| BUSINESS_EMAIL | yes | yes | no | no |
| BUSINESS_PHONE | yes | yes | no | no |
| CLOUDINARY_API_KEY | yes | yes | no (silent disable) | no |
| CLOUDINARY_API_SECRET | yes | yes | no (silent disable) | no |
| CLOUDINARY_CLOUD_NAME | yes | yes | no (silent disable) | no |
| COMMIT_SHA | yes | **NO** | no | yes (chained in server.js:10-17) |
| CSRF_MODE | yes | yes | no (default 'enforce'?) | no |
| DATABASE_URL | yes | yes | **YES (server.js:52 fatal; bootCheck)** | no |
| DATABASE_URL_DIRECT | yes (job_queue.js) | **NO** | no (falls back to DATABASE_URL) | yes |
| DEBUG_DASHBOARD_SLA | yes | **NO** | no | no |
| DOCTOR_RESPONSE_TIMEOUT_HOURS | yes | **NO** | no (default 24) | no |
| EMAIL_ENABLED | yes | yes | no (default false) | no |
| EMAIL_GUARD_STRICT | yes | yes | no | no |
| EMAIL_TEST_STUB | yes | **NO** | no | no |
| FB_PAGE_ID | yes | yes | no | no |
| GIT_SHA | yes | **NO** | no | yes (chain in server.js) |
| IG_ACCESS_TOKEN | yes | yes | no (silent disable) | no |
| IG_BUSINESS_ACCOUNT_ID | yes | yes | no | no |
| JWT_SECRET | yes | yes | **YES (server.js:52 fatal; requireJWT.js:14)** | yes (\|\| SESSION_SECRET) |
| LANG_COOKIE_NAME | yes | **NO** | no (default 'lang') | no |
| LAUNCH_DATE | yes | yes | no | no |
| MAX_ACTIVE_CASES_PER_DOCTOR | yes | **NO** | no (default 4) | no |
| MEDIA_BASE_URL | yes | yes | no | no |
| META_APP_ID | yes | yes | no | no |
| META_APP_SECRET | yes | yes | no | no |
| MODE | yes | yes | yes (bootCheck asserts) | aliased w/ NODE_ENV in two files |
| NATIONAL_ID_ENCRYPTION_KEY | yes | yes | required for doctor signup (silent fail upstream) | no |
| NODE_ENV | yes | yes | no, but used inconsistently | aliased w/ MODE in two files |
| NOTIFICATION_DRY_RUN | yes | yes | no | no |
| NOTIFICATION_MAX_RETRIES | yes | yes | no | no |
| NOTIFICATION_WORKER_ENABLED | scripts only | yes | no | no |
| NOTIFICATION_WORKER_INTERVAL_MS | scripts only | yes | no | no |
| OPENAI_API_KEY | yes | yes | no (silent disable in IG routes) | no |
| OPS_PASS | yes | yes | required for /ops login (silent disable) | no |
| OPS_USER | yes | yes | required for /ops login (silent disable) | no |
| OPS_SSH_HOST | yes | yes | no | no |
| OPS_SSH_KEY_PATH | yes | yes | no | no |
| OPS_SSH_USER | yes | yes | no | no |
| PAYMOB_CARD_INTEGRATION_ID | yes | yes | required for live | no |
| PAYMOB_HMAC_SECRET | yes | yes | required for callbacks | no |
| PAYMOB_LIVE_PAYMENTS | yes | **NO** | toggles patient-side live UI | no |
| PAYMOB_MODE | yes | yes | hard-gated to 'test' | no |
| PAYMOB_NOTIFICATION_URL | yes | yes | required | no |
| PAYMOB_PUBLIC_KEY | yes | yes | required | no |
| PAYMOB_SECRET_KEY | yes | yes | required | no |
| PG_POOL_CONNECT_TIMEOUT_MS | yes | **NO** | no (default 15000) | no |
| PG_POOL_IDLE_TIMEOUT_MS | yes | **NO** | no (default 30000) | no |
| PG_POOL_MAX | yes | **NO** | no (default 10) | no |
| PG_SSL | yes | yes | required true on Render | no |
| PORT | yes | yes | no (default 3000) | no |
| PRICE_RANGE_MAX | yes | yes | no | no |
| PRICE_RANGE_MIN | yes | yes | no | no |
| PUBLIC_ORDER_API_KEY | yes | yes | no | no |
| R2_ACCESS_KEY_ID | yes | **NO** | no (silent disable) | no |
| R2_BUCKET_NAME | yes | **NO** | no (silent disable) | no |
| R2_ENDPOINT | yes | **NO** | no (silent disable) | no |
| R2_SECRET_ACCESS_KEY | yes | **NO** | no (silent disable) | no |
| RENDER_COMMIT | yes | **NO** | no | yes (chain) |
| RENDER_GIT_COMMIT | yes | yes (commented) | no | yes (chain) |
| RENDER_SERVICE_NAME | yes | yes (commented) | no | no |
| RESEND_API_KEY | yes | **NO** | required for email send (silent disable) | no |
| SEED_DEMO_DATA | yes | **NO** | no (default off; gated to MODE=staging) | no |
| SESSION_COOKIE_NAME | yes | yes | no | no |
| SESSION_SECRET | yes | **NO** | only as JWT_SECRET fallback | yes (JWT\_SECRET \|\| SESSION\_SECRET) |
| SKILL_NAME | yes | **NO** | no | no |
| SLA_AUTO_PAUSE_BREACHES | yes | yes | no | no |
| SLA_AUTO_PAUSE_WINDOW_DAYS | yes | yes | no | no |
| SLA_DRY_RUN | yes | yes | no | no |
| SLA_ENFORCEMENT_ENABLED | yes | yes | no | no |
| SLA_ENFORCEMENT_INTERVAL_MS | yes | yes | no | no |
| SLA_MODE | yes | yes | required outside dev | no |
| SLA_PRIMARY_TOKEN | yes | yes | required when SLA_MODE=primary | no |
| SLA_REMINDER_MINUTES | yes | yes | no | no |
| SMOKE_BASE_URL | scripts only | yes | no | no |
| SMTP_FROM_EMAIL | yes | yes | no (used by Resend adapter) | no |
| SMTP_FROM_NAME | yes | yes | no | no |
| SMTP_HOST | **NO (unused)** | yes | dead doc | no |
| SMTP_PASS | **NO (unused)** | yes | dead doc | no |
| SMTP_PORT | **NO (unused)** | yes | dead doc | no |
| SMTP_SECURE | **NO (unused)** | yes | dead doc | no |
| SMTP_USER | **NO (unused)** | yes | dead doc | no |
| STAGING_PASS | yes | **NO** | only as BASIC\_AUTH\_PASS alias | yes |
| STAGING_USER | yes | **NO** | only as BASIC\_AUTH\_USER alias | yes |
| TASH_API_KEY | yes | yes | required | no |
| TESTFLIGHT_URL | yes | **NO** | no | no |
| TWILIO_ACCOUNT_SID | yes | yes | required for video/OTP-Verify (silent disable) | no |
| TWILIO_API_KEY | yes | yes | required for video | no |
| TWILIO_API_SECRET | yes | yes | required for video | no |
| TWILIO_AUTH_TOKEN | yes | yes | required | no |
| TWILIO_VERIFY_SERVICE_SID | yes | yes | required for SMS OTP | no |
| UNSUBSCRIBE_SECRET | yes | yes | required for email unsub links | no |
| UPLOADCARE_KEY | yes (verify.js fallback) | **NO** | alias only | yes |
| UPLOADCARE_PUBLIC | yes (verify.js fallback) | **NO** | alias only | yes |
| UPLOADCARE_PUBLIC_KEY | yes | yes | required (silent disable) | yes (chain in verify.js) |
| UPLOADCARE_SECRET_KEY | **NO (unused)** | yes | dead doc | no |
| VIDEO_CONSULTATION_ENABLED | yes | yes | no (default false) | no |
| WHATSAPP_ACCESS_TOKEN | yes | yes | required for WA send | no |
| WHATSAPP_API_VERSION | yes | yes | no (default v22.0) | no |
| WHATSAPP_ENABLED | yes | yes | no (default false) | no |
| WHATSAPP_OTP_TEMPLATE_LANG | yes | yes | no | no |
| WHATSAPP_OTP_TEMPLATE_NAME | yes | yes | no | no |
| WHATSAPP_PHONE_NUMBER_ID | yes | yes | required for WA send | no |
| WHATSAPP_TEST_STUB | yes | **NO** | no | no |

**Summary counts**

- In code, NOT in .env.example (silent risk): 28 vars — `ADDON_SYSTEM_V2`, `AGENT_NAME`, `BRAND_NAME`, `COMMIT_SHA`, `DATABASE_URL_DIRECT`, `DEBUG_DASHBOARD_SLA`, `DOCTOR_RESPONSE_TIMEOUT_HOURS`, `EMAIL_TEST_STUB`, `GIT_SHA`, `LANG_COOKIE_NAME`, `MAX_ACTIVE_CASES_PER_DOCTOR`, `PAYMOB_LIVE_PAYMENTS`, `PG_POOL_CONNECT_TIMEOUT_MS`, `PG_POOL_IDLE_TIMEOUT_MS`, `PG_POOL_MAX`, `R2_ACCESS_KEY_ID`, `R2_BUCKET_NAME`, `R2_ENDPOINT`, `R2_SECRET_ACCESS_KEY`, `RENDER_COMMIT`, `RESEND_API_KEY`, `SEED_DEMO_DATA`, `SESSION_SECRET`, `SKILL_NAME`, `STAGING_PASS`, `STAGING_USER`, `TESTFLIGHT_URL`, `UPLOADCARE_KEY`, `UPLOADCARE_PUBLIC`, `WHATSAPP_TEST_STUB`.
- In .env.example, NOT in code (dead doc): 6 vars — `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `UPLOADCARE_SECRET_KEY`. (`SMOKE_BASE_URL`, `NOTIFICATION_WORKER_ENABLED`, `NOTIFICATION_WORKER_INTERVAL_MS` are used in `scripts/`, so legitimate.)
- Aliased chains: `JWT_SECRET || SESSION_SECRET`; `BASIC_AUTH_USER || STAGING_USER`; `BASIC_AUTH_PASS || STAGING_PASS`; `DATABASE_URL_DIRECT || DATABASE_URL`; `BASE_URL || APP_URL` (×3 sites); `RENDER_GIT_COMMIT || GIT_SHA` and `GIT_SHA || COMMIT_SHA || RENDER_GIT_COMMIT || RENDER_COMMIT`; `MODE || NODE_ENV` (multiple sites); `UPLOADCARE_PUBLIC_KEY || UPLOADCARE_PUBLIC || UPLOADCARE_KEY` (verify.js).

---

## Findings

### P0-CONF-1 — RESEND_API_KEY: undocumented, silent failure on production email
**Severity:** P0 | **Category:** env-var | **Location:** src/services/emailService.js:40 | **Description:** `RESEND_API_KEY` is the actual email transport (Resend HTTP API; nodemailer was retired 2026-04-30 per file header). `process.env.RESEND_API_KEY || ''` is read at module load. If the env var is unset on Render, the SDK call will fail with an auth error and `_logEmailError` writes to `error_logs` but no boot-time alarm fires. **`RESEND_API_KEY` is not in `.env.example`.** This is the exact pattern that killed Uploadcare. | **Impact:** every transactional email (OTP, SLA, receipts) silently fails after deploy until somebody tails error_logs. | **Fix scope:** small | **Verification:** VERIFIED-code

### P0-CONF-2 — SMTP_* vars are dead doc; deployer will set them and email still won't send
**Severity:** P0 | **Category:** env-var | **Location:** .env.example:92-96 | **Description:** `.env.example` documents `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS` as the email transport. Code uses Resend exclusively (file comment in emailService.js:15-18 says SMTP was retired). A deployer following docs will configure SMTP, fail to set RESEND_API_KEY, and email is dead on launch with no error in boot logs. | **Impact:** confused deployer + dead email. | **Fix scope:** small (delete SMTP block from .env.example, add RESEND_API_KEY). | **Verification:** VERIFIED-code

### P0-CONF-3 — UPLOADCARE_PUBLIC_KEY aliases UPLOADCARE_PUBLIC / UPLOADCARE_KEY only in verify.js — patient routes do not
**Severity:** P0 | **Category:** case/alias | **Location:** src/routes/verify.js:101-103 vs src/routes/patient.js:74,1329,2660,2898,2909 | **Description:** `verify.js` accepts three spellings (`UPLOADCARE_PUBLIC_KEY || UPLOADCARE_PUBLIC || UPLOADCARE_KEY`). All seven references in `patient.js` (the actual upload UI) read **only** `UPLOADCARE_PUBLIC_KEY`. If Render still has any of the legacy spellings (the original bug), verify.js will boot a key but the patient case-creation page renders `uploaderConfigured=false` and silently disables uploads. | **Impact:** repeats the prior foundational bug class — silent-dead uploader on the page that matters. | **Fix scope:** small (collapse to one canonical name + delete the aliases). | **Verification:** VERIFIED-code

### P0-CONF-4 — Doc-only "live" payment toggle skips Paymob's mode guard
**Severity:** P0 | **Category:** mode | **Location:** src/routes/patient.js:1690,1773 + src/services/paymob.js:40-46 | **Description:** `PAYMOB_LIVE_PAYMENTS=true` flips patient-facing UI to live mode in three places, but `services/paymob.js:_assertTestMode()` hard-throws unless `PAYMOB_MODE=test`. If only `PAYMOB_LIVE_PAYMENTS` is set, the UI says "live" while the service still throws on every intention call. `PAYMOB_LIVE_PAYMENTS` is undocumented in `.env.example`. | **Impact:** user-facing live state with backend failure on every payment. | **Fix scope:** small (single source of truth; remove PAYMOB_LIVE_PAYMENTS or wire to PAYMOB_MODE). | **Verification:** VERIFIED-code

### P0-CONF-5 — JWT_SECRET silently falls back to SESSION_SECRET; SESSION_SECRET undocumented
**Severity:** P0 | **Category:** secrets/alias | **Location:** src/middleware/requireJWT.js:13 | **Description:** `const JWT_SECRET = process.env.JWT_SECRET || process.env.SESSION_SECRET;`. server.js:52 fatal-checks `JWT_SECRET` only — so if a deployer sets `SESSION_SECRET` instead (a common Express convention), `requireJWT.js` will accept it but `server.js` boot-validator will exit. Conversely, if both vars exist with different values, JWTs minted via the server.js code path use `JWT_SECRET` while requireJWT validates against the same; OK. The risk is documentation/deployer confusion: only `JWT_SECRET` is in `.env.example`. | **Impact:** boot fail or, worse, secret-rotation race if both are set during rotation. | **Fix scope:** small (drop the fallback or document it). | **Verification:** VERIFIED-code

### P0-CONF-6 — `.env.production` exists in working tree with a real Supabase password
**Severity:** P0 | **Category:** secrets | **Location:** /Users/ziadelwahsh/tashkheesa-portal/.env.production | **Description:** A 122-byte `.env.production` file sits at the repo root containing `DATABASE_URL=postgresql://postgres.wvmhliweujmhlzknmuzh:ZiadWahsh1122@aws-1-us-east-1.pooler.supabase.com:6543/postgres`. `.gitignore` blocks `.env.*` (with `!.env.example`), so it is not committed (`git ls-files` confirms only `.env.example`). Still — a real DB password in plaintext on disk and a `backups/` folder also exist. ALSO: `.env.backup-1777367095` (2.9 KB) and `.env.save` (perm 600, 2.9 KB) sit alongside. | **Impact:** any future careless `git add -A` ships the password; password rotation likely needed regardless. | **Fix scope:** small (rotate DB password; delete the on-disk plaintext copies; consider 1Password / Render-only). | **Verification:** VERIFIED-code

### P1-CONF-7 — No render.yaml / Dockerfile / Procfile / app.json in repo
**Severity:** P1 | **Category:** deploy | **Location:** repo root | **Description:** No infrastructure-as-code. Render config lives entirely in the dashboard. Re-creating the service after an account/region migration or restoring after deletion requires tribal knowledge. PRIOR foundational bug (case mismatch) is precisely the kind of thing render.yaml under version control would have prevented. | **Impact:** disaster-recovery TTR; new-engineer onboarding; env-var drift between local and Render. | **Fix scope:** medium (commit a render.yaml that declares envVarGroups + service settings). | **Verification:** VERIFIED-code

### P1-CONF-8 — server.js boot validator only checks 3 vars; 14+ "required" vars silently disable
**Severity:** P1 | **Category:** boot | **Location:** src/server.js:51-68 | **Description:** Validator requires only `JWT_SECRET`, `DATABASE_URL`, `ANTHROPIC_API_KEY`. The following are de-facto required for production but degrade silently when missing: `RESEND_API_KEY`, `UPLOADCARE_PUBLIC_KEY`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `ADMIN_PHONE`, `PAYMOB_PUBLIC_KEY`/`SECRET_KEY`/`HMAC_SECRET`/`CARD_INTEGRATION_ID`/`NOTIFICATION_URL`, `TWILIO_*` (5 vars), `NATIONAL_ID_ENCRYPTION_KEY`, `OPS_USER`/`OPS_PASS`, `UNSUBSCRIBE_SECRET`, `TASH_API_KEY`, `PG_SSL`. server.js:52 list is the chokepoint; everything else falls back to `|| ''` and breaks at first use. | **Impact:** the prior class of bug. | **Fix scope:** medium (extend validator to require, in production-mode only, the full integration set; warn-only in dev). | **Verification:** VERIFIED-code

### P1-CONF-9 — MODE vs NODE_ENV: 8 inconsistent gates across the codebase
**Severity:** P1 | **Category:** mode | **Location:** multi-file | **Description:** Two parallel mode systems are mixed:
- MODE-only gates: `src/logger.js:3`, `src/server.js:481` (demo seed), `src/bootCheck.js:17` (chains both, normalises to MODE).
- NODE_ENV-only gates: `src/auth.js:141` (cookie `secure`), `src/routes/campaigns.js:16`, `src/routes/superadmin.js:30`, `src/routes/tash-api.js:10`, `src/routes/public_orders.js:188,193`, `src/routes/api_v1.js:155`, `src/routes/ops.js:190` (cookie `secure`), `src/routes/patient.js:2174`.
- Mixed: `src/routes/auth.js:12-13` (`MODE = process.env.MODE || NODE_ENV`), `src/routes/ops.js:500`, `src/server.js:75`.

If `MODE=production` but `NODE_ENV=development` (or unset), all the cookie-`secure` gates and prod 404s in `public_orders` / `tash-api` flip the wrong way. bootCheck normalizes `process.env.MODE` but does NOT normalize `NODE_ENV`. | **Impact:** insecure cookies in production OR exposed dev routes in production, depending on which side is wrong. | **Fix scope:** medium (pick one, normalize the other in bootCheck). | **Verification:** VERIFIED-code

### P1-CONF-10 — WhatsApp critical-alert credentials captured at require-time, not per-call
**Severity:** P1 | **Category:** env-var | **Location:** src/critical-alert.js:6-9 | **Description:** `ADMIN_PHONE`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_API_VERSION` are read once at module load into module-level `var`s. After the prior incident where the WA token expired, rotating it requires a server restart to take effect on critical alerts (other call sites read at call-time). PLUS: there is no monitoring on token validity — `req.on('error', function() {})` swallows everything (line 53). | **Impact:** repeats the "WhatsApp token expired with no monitoring" foundational bug for the alerting pathway specifically. | **Fix scope:** small (read env at call-time + log to error_logs on send failure). | **Verification:** VERIFIED-code

### P1-CONF-11 — server.js boot DB log leaks credentials when regex misses (tested only against `//user:pw@host` shape)
**Severity:** P1 | **Category:** secrets | **Location:** src/server.js:84 | **Description:** `(process.env.DATABASE_URL || '').replace(/\/\/.*@/, '//<credentials>@')` is greedy. For multi-`@` URLs (rare but legal) this works; for a connection string with `?password=…` query syntax the password is logged. Not the dominant case but a one-line fix. | **Impact:** secret in stdout if URL format ever shifts. | **Fix scope:** small (parse URL.username/password explicitly). | **Verification:** INFERRED

### P1-CONF-12 — Demo seed staging-gate is correct but flag is undocumented
**Severity:** P1 | **Category:** mode | **Location:** src/server.js:481-491 + src/bootCheck.js:22 | **Description:** `if (MODE === 'staging') { if (SEED_DEMO_DATA === '1') seedDemoData(); }` — gate is verified correct: bootCheck restricts MODE to `development|staging|production`, and `MODE === 'staging'` strictly equals (not includes). Demo seed cannot run with `MODE=production`. **However** `SEED_DEMO_DATA` is not in `.env.example`. Rebuilding staging from scratch you'd never know to set it. | **Impact:** staging boots with empty data + no signal. | **Fix scope:** small (document SEED_DEMO_DATA). | **Verification:** VERIFIED-code

### P1-CONF-13 — bootCheck DATABASE_URL fail-open in development
**Severity:** P1 | **Category:** boot | **Location:** src/bootCheck.js:92-98 | **Description:** Missing DATABASE_URL only `console.warn`s in development (`mode === 'development'`). server.js:52 then fatals because it's in the required list — but **only after bootCheck logs success**. Inconsistent: bootCheck says "warn", server.js validator says "exit". The exit wins, but the user sees a confusing "Boot checks passed" then a fatal. | **Impact:** misleading boot logs. | **Fix scope:** small (delete the dev-warn branch in bootCheck — server.js validator covers it). | **Verification:** VERIFIED-code

### P1-CONF-14 — UPLOADCARE_SECRET_KEY documented but never read
**Severity:** P1 | **Category:** env-var | **Location:** .env.example:88 | **Description:** The Uploadcare secret key is documented but no `process.env.UPLOADCARE_SECRET_KEY` reference exists in `src/`, `scripts/`, or `tests/`. If the upload flow needs server-side signed delete/verify in future, the key would be silently unused. | **Impact:** dead doc; possible feature-not-wired. | **Fix scope:** small (delete or wire). | **Verification:** VERIFIED-code

### P1-CONF-15 — R2_* (Cloudflare R2) keys read in code, undocumented
**Severity:** P1 | **Category:** env-var | **Location:** src/ (4 R2 vars referenced) | **Description:** `R2_ACCESS_KEY_ID`, `R2_BUCKET_NAME`, `R2_ENDPOINT`, `R2_SECRET_ACCESS_KEY` are read in src but absent from `.env.example`. Whatever feature uses R2 will silent-disable in production. Same bug class as Uploadcare. | **Impact:** any R2-backed feature dark on launch. | **Fix scope:** small. | **Verification:** VERIFIED-code

### P1-CONF-16 — STAGING_USER / STAGING_PASS aliases undocumented
**Severity:** P1 | **Category:** alias | **Location:** src/server.js:78-79 | **Description:** `BASIC_AUTH_USER || STAGING_USER` chain accepts a legacy spelling. Both `STAGING_USER` and `STAGING_PASS` are undocumented in `.env.example`. If a deployer reading the code uses `STAGING_USER`, bootCheck.js:73-77 reads only `BASIC_AUTH_USER`, asserts missing, and exits — even though server.js would have accepted the alias. The fallback chain runs after the assert. | **Impact:** boot exits for a value it would have accepted. | **Fix scope:** small (drop alias OR move it before bootCheck). | **Verification:** VERIFIED-code

### P2-CONF-17 — DATABASE_URL_DIRECT used by job_queue silently falls back to pooler URL (Supabase)
**Severity:** P2 | **Category:** env-var | **Location:** src/job_queue.js:14 | **Description:** `DATABASE_URL_DIRECT || DATABASE_URL`. On Supabase the pooler URL (port 6543) does not support `LISTEN`/long-lived connections; the direct URL (port 5432) does. If `DATABASE_URL_DIRECT` is unset on Render and the queue uses LISTEN, listeners die without error. `DATABASE_URL_DIRECT` is undocumented. | **Impact:** queue silently degrades to polling-only. | **Fix scope:** small (document + log when fallback is taken). | **Verification:** INFERRED (depends on whether job_queue uses LISTEN; the env var name implies yes).

### P2-CONF-18 — PG_POOL_MAX / CONNECT_TIMEOUT_MS / IDLE_TIMEOUT_MS undocumented
**Severity:** P2 | **Category:** env-var | **Location:** src/pg.js:38-40 | **Description:** Three pool tuning knobs are read but undocumented. Defaults (10/15s/30s) are reasonable; the issue is operational tuning during incidents requires source-diving. | **Impact:** ops-time friction. | **Fix scope:** small. | **Verification:** VERIFIED-code

### P2-CONF-19 — IG / OpenAI silent disables warn only; not surfaced anywhere
**Severity:** P2 | **Category:** boot | **Location:** src/instagram/scheduler.js:24, src/instagram/routes.js:164,195 | **Description:** `if (!process.env.IG_ACCESS_TOKEN) { console.warn(...); return; }` — same for OPENAI_API_KEY. Production logs are not aggregated into a single "missing env var manifest" surface; first sign you're missing IG_ACCESS_TOKEN is no posts going out. | **Impact:** features dark with no admin signal. | **Fix scope:** medium (single boot manifest endpoint surfacing every silent-disable). | **Verification:** VERIFIED-code

### P2-CONF-20 — NODE_ENV !== 'production' opens "test endpoints" in three routers
**Severity:** P2 | **Category:** mode | **Location:** src/routes/campaigns.js:16, src/routes/tash-api.js:10, src/routes/public_orders.js:188,193 | **Description:** Pattern is `if (process.env.NODE_ENV === 'production') return res.status(404)`. If the deploy sets only `MODE=production` and leaves `NODE_ENV` unset, these routes are LIVE in production. (Render sets `NODE_ENV=production` by default, but is not guaranteed for Express services unless declared.) | **Impact:** dev-only routes exposed if NODE_ENV unset. | **Fix scope:** small (gate on MODE consistently; add NODE_ENV to bootCheck assert). | **Verification:** VERIFIED-code

### P2-CONF-21 — server.js:75 SLA_MODE default flips on (MODE=development → SLA_MODE=primary)
**Severity:** P2 | **Category:** mode | **Location:** src/server.js:74-76 | **Description:** `SLA_MODE: String(process.env.SLA_MODE || (MODE === 'development' ? 'primary' : 'passive'))`. Combined with bootCheck.js:32-34 which defaults SLA_MODE to **passive** in development if missing, then bootCheck WRITES `process.env.SLA_MODE='passive'`, so server.js:75 reads 'passive' from env (not the dev branch). The dev-branch `'primary'` literal in server.js is dead code today, but a `delete process.env.SLA_MODE` after bootCheck would activate it — fragile. | **Impact:** divergence between two defaults; future refactor hazard. | **Fix scope:** small (single source of truth). | **Verification:** VERIFIED-code

### P2-CONF-22 — ALLOW_PRIMARY_IN_DEV documented as default false but bootCheck-only check
**Severity:** P2 | **Category:** mode | **Location:** src/bootCheck.js:58-69 | **Description:** Useful guardrail; just noting that the env var is correctly documented, gated, and only meaningful when `SLA_MODE=primary && MODE=development`. No fix required, but raise visibility — flagging this as a verified-good guardrail. | **Impact:** none. | **Fix scope:** none. | **Verification:** VERIFIED-code (positive finding)

### P2-CONF-23 — recipientGuard logs AGENT_NAME / SKILL_NAME (Anthropic-Claude-Code-internal env vars) into DB
**Severity:** P2 | **Category:** env-var | **Location:** src/services/recipientGuard.js:155-156 | **Description:** `process.env.AGENT_NAME` and `process.env.SKILL_NAME` are written into a DB column on every blocked-send. These vars only exist when the server is run inside a Claude Code agent session — in production they're always null. Probably leftover from dev. | **Impact:** dead column writes; tiny perf/clarity hit. | **Fix scope:** small. | **Verification:** VERIFIED-code

### P2-CONF-24 — getGitSha shells out to `git rev-parse` if env vars missing
**Severity:** P2 | **Category:** boot | **Location:** src/server.js:10-25 | **Description:** Boot calls `execSync('git rev-parse --short HEAD')` if all four env vars are unset. Render injects `RENDER_GIT_COMMIT` automatically so this is normally fine; but if the build cache is corrupt or `.git` missing in the slug, this is one of the failure points. The try/catch returns null gracefully — only verifying the path is harmless. | **Impact:** none in steady state. | **Fix scope:** none. | **Verification:** VERIFIED-code

### P2-CONF-25 — RESEND_API_KEY missing → emailService stays loaded with empty key, returns auth error per-call (not boot-time fail)
**Severity:** P2 | **Category:** boot | **Location:** src/services/emailService.js:40 | **Description:** Same issue as P0-CONF-1 with a different mitigation framing: even adding RESEND_API_KEY to the boot validator would help. Currently the empty-string default lets every call attempt and fail individually. There is `_logEmailError` writing to error_logs (good), but no SLO alarm on email_send_failed rate. | **Impact:** detection lag. | **Fix scope:** small. | **Verification:** VERIFIED-code

### P3-CONF-26 — Five "module-load env capture" sites prevent Render env-var rotation without redeploy
**Severity:** P3 | **Category:** env-var | **Location:** critical-alert.js:6-9, emailService.js:39-40,86-87, paymob.js (per-function but module-level fallbacks), notify/whatsapp.js (`WHATSAPP_ENABLED` const) | **Description:** Several modules read `process.env` once at require-time into module-level constants. Render env var changes require a full deploy/restart to take effect. Industry norm is to either re-read at call time or expose a `refresh()` hook. | **Impact:** any secret rotation = downtime + manual restart. | **Fix scope:** small. | **Verification:** VERIFIED-code

### P3-CONF-27 — Doc drift: RELEASE_CHECKLIST.md and RISK_REGISTER.md still reference SQLite remnants and Gmail SMTP migration as April-2026
**Severity:** P3 | **Category:** mode | **Location:** RELEASE_CHECKLIST.md, RISK_REGISTER.md | **Description:** RISK_REGISTER section 1 has a 2026-04 stack note that's correct (PostgreSQL on Render, not SQLite). RELEASE_CHECKLIST is generic. PHASE_2_BACKLOG focuses on doctor-portal redesign and is up-to-date. No critical drift in these three. | **Impact:** none. | **Fix scope:** none — informational. | **Verification:** VERIFIED-code

### P3-CONF-28 — Three on-disk env files (.env, .env.production, .env.backup-1777367095, .env.save) and `backups/` folder are gitignored — verify shred / 1Password parity
**Severity:** P3 | **Category:** secrets | **Location:** filesystem | **Description:** `.gitignore` correctly excludes them. `git ls-files` shows only `.env.example`. Risk is operational: laptop loss → all four env files exposed. `.env.save` is mode 600 (good); others are 644. Recommend rotating all secrets that have ever lived in those files and pushing only to Render's environment-group secret store. | **Impact:** local-machine secret hygiene. | **Fix scope:** small. | **Verification:** VERIFIED-code

### P3-CONF-29 — No hardcoded `sk_live`, private keys, or live secrets in src/scripts/.env.example
**Severity:** P3 (positive) | **Category:** secrets | **Location:** repo-wide | **Description:** Grep for `sk_live`, `live_secret`, `BEGIN PRIVATE KEY`, `BEGIN RSA PRIVATE` returned zero hits across `src/`, `scripts/`, and `.env.example`. | **Impact:** none — verified clean. | **Fix scope:** none. | **Verification:** VERIFIED-code (positive finding)

---

## Top 5 fix order (suggested)

1. **P0-CONF-1 + P0-CONF-2** (10 min): add `RESEND_API_KEY` to `.env.example`, delete the SMTP block, add `RESEND_API_KEY` to server.js:52 required list. Eliminates the highest-probability launch outage.
2. **P0-CONF-3** (15 min): remove the UPLOADCARE alias chain in verify.js; one canonical name `UPLOADCARE_PUBLIC_KEY` everywhere.
3. **P0-CONF-4** (20 min): remove `PAYMOB_LIVE_PAYMENTS`; the patient UI should derive live state from `PAYMOB_MODE` (the same var paymob.js gates on).
4. **P0-CONF-6** (30 min): rotate Supabase password, delete `.env.production` / `.env.backup-*` / `.env.save` from disk; commit a render.yaml (P1-CONF-7) at the same time.
5. **P1-CONF-9** (1 hr): unify MODE/NODE_ENV. Make bootCheck normalize both. Replace every `NODE_ENV === 'production'` with `MODE === 'production'`.
