# Pre-Launch Final Audit — Tashkheesa Portal

**Date:** 2026-04-30
**Auditor:** Claude Opus 4.7 (1M context), interactive
**Working tree HEAD:** `ebbfd51` (matches prod `/__version` git_sha = `ebbfd51ff6570c7483eea434a82b0b9e7ec88769`)
**Branch:** `main`
**Methodology:** static code review + production curl probes against `https://tashkheesa.com` + read-only SQL against production Supabase.

---

## Phase 0 — environment + ground rules

### Production database (GR-DB-1)

- `DATABASE_URL` in `.env.production` resolves to **Supabase pooler** at `aws-1-us-east-1.pooler.supabase.com:6543`, project ref `wvmhliweujmhlzknmuzh` (matches the canonical project ref recorded in GR-DB-1; the pooler is the standard PgBouncer endpoint that fronts the same `postgres.wvmhliweujmhlzknmuzh.supabase.co` direct host — same database, different access path).
- All SQL claims below are tagged **VERIFIED-prod** when executed against this hostname; the connection result echoed `current_database=postgres`, `current_user=postgres`, `server_version=17.6`.
- 33 migrations applied on prod (`schema_migrations` table). All today's fixes (024 `blocked_send_attempts`, 025 `email_campaigns_approval`, 026 `addon_commission_fix`, 027 `urgency_multipliers`, 028 `refunds`, 030 `urgency_uplift_amount`, 031 `canonicalize_urgency_tier_vip`, 032 `orders_paid_at`) are present.
- **Migration numbering anomaly:** files `020_orders_paid_at.sql` and `032_orders_paid_at.sql` both exist in `src/migrations/` and **both** have a row in `schema_migrations` (id 18 + 33). `orders.paid_at` exists exactly once (`information_schema.columns` count = 1). 020 was an earlier attempt that was either rolled back or `IF NOT EXISTS`-guarded; 032 is the canonical fix landed today. **No production harm**, but two files for the same column is bad hygiene — keep 032 and delete 020 (or convert to a no-op marker). There is **no migration 029** in the file tree (gap between 028 and 030); cosmetic.

### Production state

| | Value | Source |
|---|---|---|
| Mode | `production` | `/__version` |
| SLA worker | `slaMode=primary` | `/__version` |
| Uptime at audit start | 1,747 s (~29 min) | `/__version` |
| Active doctors | **1** | `users WHERE role='doctor' AND is_active`; pending=0 |
| Patients | 8 (mostly seed) | `users WHERE role='patient'` |
| Orders total | **3** (2 expired_unpaid, 1 cancelled) | `orders` |
| Paid orders ever | **0** | `orders WHERE payment_status='paid'` |
| `doctor_earnings` rows | **0** | `doctor_earnings` |
| `addon_earnings` rows | **0** | `addon_earnings` |
| `order_addons` rows | **0** | `order_addons` |
| `refunds` rows | **0** | `refunds` |

> **Implication:** the entire payment / earnings / refund / addon pipeline has **never been exercised in production**. Launch day will run real money through code paths that have, in production, only ever returned 0 rows. This is the main reason the P0s below matter — every one of them is a latent bug that will surface on the first paid order.

### Ground-rule application

Every finding below tags evidence as:
- **VERIFIED-prod** — direct SQL against Supabase or direct curl against `tashkheesa.com` (cite the response).
- **VERIFIED-code** — explicit code+behavior trace at `file:line`.
- **INFERRED** — read from code, reasoned conclusion (cannot prove without runtime exercise).
- **UNVERIFIED** — needs runtime access or a test transaction the audit didn't have.

GR-FINANCIAL-1 (catalog blast-radius) — applied: any pricing-data finding has its production blast-radius noted (almost universally **0 affected paid orders** because there are none).

---

## Section 0 — coverage checklist

This is the surface map I walked. Each row's last column is what I actually did.

### A. Public/marketing
| Surface | Verdict | Evidence |
|---|---|---|
| `/` (homepage) | OK | curl 200; CSP+CSRF+HSTS headers tight |
| `/about` | OK | curl 200 |
| `/contact` | OK | curl 200 |
| `/services` | OK | curl 200 |
| `/privacy`, `/terms` | OK | curl 200 |
| `/how-it-works` | OK (anchor) | curl redirects to `/#how-it-works` |
| `/specialties` | **404** | curl 404 — see P1-PUB-1 |
| `/blog` | **404** | curl 404 — see P1-PUB-1 |
| `/faq` | **404** | curl 404 — see P1-PUB-1 |
| `/help-me-choose` | OK with bad CTA | curl 200; submit URL → /order/start (dead) — P1-PUB-2 |
| `/order/start` | broken-by-design | renders coming_soon — P1-PUB-3 |
| `/coming-soon` | OK | renders coming_soon |
| `/healthz`, `/__version` | OK | both return JSON |
| Language toggle (`/lang/ar`, `/lang/en`) | UNVERIFIED — code-only | not curl-exercised; legacy April finding 9.4 (`/lang/ar` redirects unauth to `/login`) re-flag below |

### B. Auth flows
| Surface | Verdict | Evidence |
|---|---|---|
| GET `/login` | OK | curl 200; csrf_token + lang cookies set |
| POST `/login` (success/fail) | INFERRED OK | code trace `auth.js:197-266` — proper error copy, role-based redirect, `pending_approval` gate, locked-account gate |
| GET `/register` | OK | curl 200 |
| POST `/register` | INFERRED OK | `auth.js:559-650` — country whitelist, email-exists check, welcome email queued, redirect to onboarding |
| GET `/forgot-password` | OK | curl 200 |
| POST `/forgot-password` (portal) | INFERRED OK after today's fix | `auth.js:280-329` — sendEmail wired ✓, but **patient-only filter** — see P1-AUTH-1 |
| POST `/api/v1/auth/forgot-password` (mobile) | INFERRED OK after today's fix | `api/auth.js:271-314` — uses `password_reset_tokens` ✓ |
| POST `/api/v1/auth/reset-password` (mobile) | **BROKEN** | `api/auth.js:327-338` queries `users.reset_token` which is no longer written — see P0-AUTH-1 |
| GET/POST `/reset-password/:token` | INFERRED OK | `auth.js:457-543`, validates token, marks used_at |
| GET/POST `/set-password` | INFERRED OK | `auth.js:391-451`, requires session, gates on `password_hash IS NULL` |
| GET/POST `/logout` | INFERRED OK | `auth.js:787-798`, clears session cookie |
| GET `/doctor/login`, `/doctor/signup` | OK | curl 200 |
| POST `/doctor/signup` | INFERRED OK | `auth.js:692-775`, sets `pending_approval=true`, queues internal notification |
| Forgot-password for doctors | **No path** | `auth.js:283` filters `role='patient'` — see P1-AUTH-1 |

### C. Patient case intake (post-login wizard)
| Surface | Verdict | Evidence |
|---|---|---|
| GET `/patient/new-case` (step 1-5) | OK code | `patient.js:1126-1300` — 5-step wizard, requires `role='patient'` |
| POST `/patient/new-case/step1` (condition) | OK code | `patient.js:1331-1392` |
| POST `/patient/new-case/step2` (documents) | OK code | `patient.js:1399-1426` — file count guard |
| POST `/patient/new-case/step3` (specialty/service) | OK code | `patient.js:1432-1476`, validates specialty + service-belongs-to-specialty |
| POST `/patient/new-case/step4` (review/SLA) | partial | `patient.js:1481-1508` — see P1-PATIENT-1 (urgency tier never offered, SLA always 72h) |
| POST `/patient/new-case/step5` (pay) | INFERRED OK | `patient.js:1517-1551`; live mode resolves Paymob URL via `getOrCreatePaymentUrl`, stub mode bounces to `/payment-success?stub=1` |
| GET `/portal/patient/payment-return` | INFERRED OK | `patient.js:1564-1594`, ownership-gated, status-mapped |
| GET `/portal/patient/orders/:id/payment-success` | INFERRED OK in stub, **broken in live** if webhook 403'd | `patient.js:1605-1683` — see P0-PAY-1 |
| Paymob webhook POST `/payments/callback` | **BROKEN** | curl returns 403 (CSRF middleware blocks before HMAC) — see P0-PAY-1 |
| Old `/order/start` legacy flow | broken-by-design | `order_flow.js:115-117` hard-renders coming_soon |
| `service_assistant` / help-me-choose | broken CTA | submits to `/order/start` → coming_soon |

### D. Patient post-payment + dashboard
| Surface | Verdict | Evidence |
|---|---|---|
| `/dashboard` (auth-gated) | UNVERIFIED — no session | curl unauth → redirects to `/login?next=/dashboard` ✓ |
| Patient dashboard CTAs | OK code | `patient_dashboard.ejs:375` "Start my case" → `/patient/new-case` ✓ |
| Patient prescriptions, records, referrals, reviews | UNVERIFIED — auth-gated | code-only review of routes; `.bak` siblings exist (P2-CLEANUP-1) |

### E. Doctor portal
| Surface | Verdict | Evidence |
|---|---|---|
| GET `/portal/doctor/today`/dashboard | INFERRED OK | `doctor.js:127`, queries `orders WHERE doctor_id=?` |
| GET `/portal/doctor/queue`, `/cases`, `/completed` | INFERRED OK | `doctor.js:455-557` |
| GET `/portal/doctor/case/:id` (case detail) | UNVERIFIED — auth-gated | `doctor.js:1205` |
| POST `/portal/doctor/case/:id/accept` | INFERRED OK | `doctor.js:1540` |
| POST `/portal/doctor/case/:id/diagnosis` | INFERRED OK | `doctor.js:1817` |
| POST `/portal/doctor/case/:id/report` (deliver) | INFERRED PARTIAL | `doctor.js:1894` — handler does NOT write `doctor_earnings` for main case — see P0-FIN-1 |
| GET `/portal/doctor/messages` | **STUB** | `doctor.js:616` "Coming in Phase 2" — see P1-DOC-1 |
| GET `/portal/doctor/earnings` | **STUB** | `doctor.js:633` "Coming in v1.5" — view tells doctor to look in case detail; see P1-DOC-2 |
| GET `/portal/doctor/profile` | INFERRED OK | `doctor.js:1918` |
| Doctor reviews received | INFERRED OK | `doctor_reviews.ejs` exists |
| Doctor signup → admin approval flow | INFERRED OK | `auth.js:692-775` queues internal notify; `superadmin.js:2088` approves |

### F. Pipelines
| Pipeline | Verdict | Evidence |
|---|---|---|
| Email transport (Resend) | OK | `services/emailService.js`; SDK adapter shape preserved; recipientGuard wrapped — see INFO-EMAIL-1 |
| Email templates EN+AR coverage | OK structurally | both `templates/email/{en,ar}/` have all 20 same-name `.hbs` files; bilingual lifecycle wrappers (`notifyCaseReceived` etc.) are EN-hardcoded — see P1-NOTIF-1 |
| In-app notifications (`notifications` table) | OK schema | `notifications` table has both legacy (`template,status,at,response`) and new (`type,title,message,is_read,data`) columns — schema is mixed |
| Notification friendly-title mapping | UNVERIFIED | did not enumerate all event templates against translator map |
| Doctor earnings ledger (main case) | **BROKEN** | no `INSERT INTO doctor_earnings` exists for main-case completion path — see P0-FIN-1 |
| Doctor earnings ledger (video addon) | OK code | `routes/video.js:805,988`, `video_scheduler.js:128` — but production rows = 0 |
| Doctor earnings ledger (prescription/video addons V2) | OK code | `services/addons/video_consult.js:73`, `prescription.js:87` write `addon_earnings` — but rows = 0 |
| Addon V1+V2 dual-write | OK code | `routes/payments.js:237-292` calls `safeDualWrite('video_consult'/'prescription', 'onPurchase', ...)` after V1 path |
| SLA enforcement | INFERRED OK | `case_sla_worker.js` sweeps; `services/sla_breach.js` issues refunds; SLA_MODE=primary on prod |
| SLA breach refund (refunds uplift only, recompute earnings) | UNVERIFIED | no breached cases in prod to verify; pure-function `services/earnings_calc.js` exists but **call sites = 0 outside tests** — see P0-FIN-1 |

### G. Admin / superadmin / ops (mutation surfaces)
| Surface | Verdict | Evidence |
|---|---|---|
| `/superadmin` (auth-gated) | OK | curl unauth → `/login?next=/superadmin` |
| Mark-paid manual (superadmin/admin) | INFERRED OK | `superadmin.js:2223`, `admin.js:1429` — should be tested with a real order on launch day |
| Reassign / cancel / extend-SLA | INFERRED OK | `superadmin.js:2476/2535/2582` |
| Doctor approve/reject | INFERRED OK | `superadmin.js:2088/2115` |
| `/superadmin/doctors/new` (create doctor) | **VULN** | `superadmin.js:1974` `console.log` of generated temp password — see P0-SEC-1 |
| Pricing catalog edits | OK code | `admin.js:2416/2471` — VIP/Urgent multipliers + service prices |
| `/ops/login`, `/ops/*` | INFERRED OK | curl `/ops/login` → 200; `requireOpsAuth` middleware on the rest |

---

## P0 — LAUNCH BLOCKERS

### P0-PAY-1 — Paymob webhook `POST /payments/callback` is CSRF-blocked before reaching HMAC verification

**Severity:** P0 — every real payment will silently fail to flip the order to `paid`.
**Surface:** Patient.
**Evidence:** **VERIFIED-prod**.

- Curl `POST https://tashkheesa.com/payments/callback` with empty JSON body → **HTTP 403** (CSRF rejection).
- `src/server.js:655` mounts `app.use('/payments', paymentRoutes)`; `src/routes/payments.js:39` defines `router.post('/callback', …)` — so the actual webhook URL is `/payments/callback`.
- `src/middleware/csrf.js:83` exempts `/callback` (no route at root → 404), `/portal/video/payment/callback` (video-only), and `/payments/webhook` (typo / wrong path) — but **NOT** `/payments/callback`. The webhook falls through to the CSRF token check, which fails because Paymob doesn't send a session cookie or token.
- The patient.js comment `patient.js:1542` confirms intent: *"the webhook (POST /payments/callback) is the source of truth"*.
- Production has 0 paid orders, so this defect has not yet caused harm — but it is the first thing that will break when a real patient pays.

**Symptom on launch day:** patient pays via Paymob iframe, Paymob POSTs to `/payments/callback`, server returns 403. Paymob retries forever. Order stays `payment_status='unpaid'` despite the patient being charged. The patient's browser hits `/portal/patient/orders/:id/payment-success` which re-queries DB, sees `payment_status != 'paid'`, renders the "we're confirming your payment" interim banner that auto-refreshes for ~60s and then suggests WhatsApp support. Lifecycle never advances to `markCasePaid`, doctor is never auto-assigned, no notification fires.

**Proposed fix (1 line):** in `src/middleware/csrf.js:83`, change `p.startsWith('/payments/webhook')` to `p.startsWith('/payments/callback')` (or add `p === '/payments/callback'` to the exempt set). Verify Paymob's webhook URL in the Paymob dashboard matches.

---

### P0-FIN-1 — `computeDoctorEarnings` still unwired (B3 from April audit, still OPEN); main-case `doctor_earnings` ledger never written

**Severity:** P0 (financial integrity at platform-accounting level).
**Surface:** Doctor + Pipeline + Admin.
**Evidence:** **VERIFIED-code** + **VERIFIED-prod**.

- `grep -rn computeDoctorEarnings src/` outside the function file + tests returns **0 results**. The pure function in `src/services/earnings_calc.js:40-68` exists with documented contract and tests, but is called nowhere.
- `INSERT INTO doctor_earnings` exists only at three sites and all are video-addon paths: `src/routes/video.js:805` and `:988` (manual schedule), and `src/video_scheduler.js:128` (auto-create). The main-case completion path (`src/routes/doctor.js:1894` POST `/portal/doctor/case/:caseId/report`, calling `handlePortalDoctorGenerateReport`) does **not** write to `doctor_earnings` at all.
- Production: `doctor_earnings` row count = **0**. So neither the doctor-side dashboard nor the admin "pending payouts" surface (`admin.js:1108`, `superadmin.js:1402-1404`) will ever show a number for main-case revenue.
- Doctor's per-month dashboard stat in `doctor.js:243-244` reads `SUM(orders.doctor_fee) FILTER (WHERE status='completed')` directly — so the doctor *does* see correct fees on the dashboard for their main-case revenue. **The doctor isn't shortchanged.** The break is at the platform-accounting level: pending payouts query returns 0 forever, the V1.5 statements page can't be populated without rewriting history, and SLA-breach earnings recalculation has nowhere to write the corrected row.

**Tagged P0** because: (a) this is the second time it's been flagged (April audit B3 → still OPEN), (b) it's the blocker for the doctor earnings page coming out of "Coming in v1.5" stub, and (c) launch-day pending-payouts dashboard will be obviously wrong to anyone running ops.

**Proposed fix:** wire `computeDoctorEarnings` at three sites per the policy:
1. **At order creation** in `patient.js POST /patient/new-case` (after the orders INSERT) — write a `doctor_earnings` row with `status='pending'`, splitting base / uplift / addon shares.
2. **At main-case completion** in `doctor.js handlePortalDoctorGenerateReport` — flip the existing pending row to `paid` (or write the row if order-creation step was skipped on legacy orders). Use `computeDoctorEarnings({ baseDoctorFee: orders.doctor_fee, upliftAmount: orders.urgency_uplift_amount, addons: order_addons rows })`.
3. **At SLA breach** in `services/sla_breach.js` — recompute with `upliftAmount=0` and update the row.

**Note:** This is mostly a back-end accounting fix. Doctors will not see different numbers. Admin "pending payouts" will start populating.

---

### P1-FIN-2 — Reassignment leaves orphan `doctor_earnings` rows _(known issue, accepted at P0-FIN-1 ship)_

**Severity:** P1 (admin-side over-counting; not user-facing).
**Surface:** Admin pending-payouts dashboard.
**Evidence:** **VERIFIED-code** at P0-FIN-1 implementation time.

When P0-FIN-1's site 1 (acceptance) writes a pending `doctor_earnings` row for the assigned doctor, and the case is later **auto-reassigned on SLA breach** (`case_lifecycle.js:1416`) or via a manual reassignment, the original doctor's pending row is **not** cancelled. When the new doctor accepts, site 1 fires again and writes a second pending row for the same `appointment_id` (the case id). Result: admin "pending payouts" sums over both rows, double-counting the case.

The auto-reassign-on-capacity path at `doctor.js:1591-1611` does **not** trigger acceptance (it just rewrites `orders.doctor_id`), so it doesn't create the duplicate — but it also leaves the original pending row pointing at a doctor who is no longer assigned. Same over-count from a different angle.

**Why accepted now:** the audit's P0-FIN-1 fix is the prerequisite. The orphan condition only manifests on reassignment, which is rare (current prod has zero breached cases). The doctor-side display is unaffected — only the `superadmin.js:1409`/`admin.js:1113` totals are impacted.

**Proposed fix (sketch (a) from P0-FIN-1 review):**
1. Widen the schema-level CHECK on `doctor_earnings.status` to include `'cancelled'` (currently no constraint exists; just text — so this is a code convention, not a migration).
2. In `case_lifecycle.js reassignCase()`, before writing the new `doctor_id`, mark all existing pending main-earnings rows for the case as `status='cancelled'`:
   ```sql
   UPDATE doctor_earnings
      SET status = 'cancelled'
    WHERE appointment_id = $caseId
      AND id LIKE 'earn-main-%'
      AND status = 'pending';
   ```
3. Update the admin/superadmin pending-payouts queries to add `AND status = 'pending'` (already present) — implicitly excludes cancelled.

**Estimated effort:** 30-45 minutes including a regression test that reassigns a paid case mid-flight and asserts the old row goes to `'cancelled'` while the new doctor's row is `'pending'`.

---

### P0-AUTH-1 — Mobile API `/api/v1/auth/reset-password` reads orphan column

**Severity:** P0 if the mobile app calls this endpoint; **P1** if it doesn't (TODO already flagged "no evidence the mobile app currently calls it" — UNVERIFIED).
**Surface:** Mobile API.
**Evidence:** **VERIFIED-code**.

- `src/routes/api/auth.js:327-338` queries `SELECT … FROM users WHERE reset_token = $1 AND reset_token_expires > NOW()` — those columns still exist on the `users` table (verified prod schema), but **no code path writes to them anymore** since today's `forgot-password` fix routed mobile token issuance to `password_reset_tokens`.
- Result: any reset token issued by `POST /api/v1/auth/forgot-password` will never satisfy the SELECT in `POST /api/v1/auth/reset-password`. Every legitimate token returns `INVALID_RESET_TOKEN`.
- Already documented in `TODO.md` as "Stranded, discovered 2026-04-30" and explicitly held back per scope rules. Re-flagging here so it isn't forgotten.

**Symptom:** if a mobile-app build ships a native reset-password screen that calls this endpoint, every password-reset attempt fails. If the mobile app routes users to the portal `/reset-password/:token` link in the email instead (which is the current flow per the TODO), this defect is dormant.

**Proposed fix (per existing TODO):** mirror the portal reset logic — `findValidToken` against `password_reset_tokens`, `UPDATE users SET password_hash` + mark token used. Then drop `users.reset_token` and `users.reset_token_expires` columns (migration 033).

---

### P0-SEC-1 — Superadmin "Create Doctor" leaks generated temp password to stdout

**Status (2026-05-03):** ✅ **RESOLVED** — superseded by token-based password-reset flow.

**Resolution evidence:** `src/routes/superadmin.js:1976-2076` (current `POST /superadmin/doctors/new` handler).
- Doctor row inserted with `password_hash = NULL` (line 1982). No temp password generated, so nothing exists to log.
- One-time token issued via `password_reset_tokens` (lines 2015-2022) — same machinery as `POST /forgot-password` in `src/routes/auth.js`.
- `emailService.sendEmail({ template: 'password-reset', ... })` sends the doctor a self-serve setup link (lines 2044-2054). Token is never echoed to stdout, the response body, or the DB outside the canonical reset-tokens table.
- On email-send failure: handler returns a 200 text response telling the superadmin to use the manual reset-link tool. Doctor row is NOT rolled back. Failure path is observable via `error_logs` (category=`email_send`) after P1-NOTIF-3.

**Codebase-wide credential-leak grep (2026-05-03):** swept `console.(log|error|warn|info|debug)` for occurrences of `password|temp_pass|tempPassword|tempPass|secret|api_key|apiKey|token` in production code (excluding tests).

| File:line | Match | Verdict |
|---|---|---|
| `src/create_test_doctor.js:64,67` | logs hardcoded test password `Doctor123!` | **NEW FINDING (P3)** — manual seed script, run by hand with `DATABASE_URL` env. The "leaked" value is hardcoded in the script source (line 18), so it's not a runtime credential leak in any meaningful sense. Suggest moving the password to an env var and printing only "password set; run with DOCTOR_PASSWORD=… to override" in a follow-up. Not blocking. |
| `src/bootCheck.js:68` | "ALLOW_PRIMARY_IN_DEV enabled — running SLA_MODE=primary in development (token acknowledged)" | False positive — the word "token" appears in a banner string; no token value is logged. |
| `src/middleware/push.js:46,80` | `[push] Invalid push token for user ${userId}` / `[push] Removed invalid token for user ${userId}` | False positive — logs user id and the *fact* of an invalid push token, not the token value. |
| `src/instagram/scheduler.js:122,126` | `[IG Scheduler] Refreshing access token...` / `Token refreshed. Expires in X days` | False positive — logs the action, not the token. |
| `src/routes/auth.js:321`, `src/routes/api/auth.js:312` | `[forgot-password] email send failed: <err.message>` | False positive — error-message logging only; no token in the payload. |

**Outcome:** P0-SEC-1 is closed. One new low-severity finding filed (`create_test_doctor.js`) for follow-up; not in scope for P1-NOTIF-3.

---

### P0-FORM-1 — Patient signup phone field is OPTIONAL; WhatsApp parity meaningless without phone capture

**Severity:** P0 (launch blocker).
**Surface:** Patient signup form; downstream notification dispatch.
**Evidence:** **VERIFIED-data**.

- Production `users` table audit (2026-05-03): 8/37 patients have a `phone` value populated (≈22%). 78% of existing patients have NO phone on file.
- Of the 8 with phones, formats vary: most are `+201XXXXXXXXX` (E.164 with `+`), some are truncated test data (`+2010`), one example with embedded spaces (`+20 100 123 4567`). `sendWhatsApp` strips non-digits at dispatch, so format inconsistency doesn't break sends — but the optionality at signup means the column is empty for the majority.
- Surfaced while shipping P1-NOTIF-1 (WhatsApp parity for case-acceptance and payment-confirmation events). Both flows already call `queueMultiChannelNotification` with `channels: ['email', 'whatsapp', 'internal']`. The WhatsApp channel silently skips with `{ skipped: true, reason: 'no_phone' }` for any user without `users.phone`. Net effect: WhatsApp parity is wired and tested, but only delivers to ~22% of patients on launch.

**Why P0 (launch blocker):**
Egyptian patients heavily prefer WhatsApp over email for transactional notifications. Shipping with email-only delivery to 78% of the user base undermines the case-acceptance and payment-confirmation UX — the two highest-value patient touchpoints in the funnel.

**Proposed fix:**
1. Make `phone` REQUIRED in the patient signup form (`src/routes/auth.js` register handler + frontend form).
2. Validate E.164 format server-side: leading `+`, country code, 8–15 digits total (`/^\+[1-9]\d{7,14}$/`). Strip spaces before validation.
3. Backfill prompt for existing 29 patients who lack a phone: on next login, redirect to a one-time `/profile/phone` form before granting access to dashboard. Skipping the form is a deliberate opt-out (set `users.notify_whatsapp = false`).
4. Add a unit test asserting an attempt to register without a phone returns 400.

Out of scope for this fix: SMS-OTP verification of the entered phone (P3). Initial release just trusts the form input — same posture as email.

---

## P1 — should fix before launch (high signal but not catastrophic)

### Patient

**P1-PATIENT-1 — `/patient/new-case` wizard does not honor policy SLA hours or urgency tiers.**
*Evidence:* **VERIFIED-code**. `patient.js:1500` writes `urgency_tier` as `'priority'` (legacy) instead of canonical `'vip'` from migration 031. `patient.js:1807-1813` derives `slaHours` from `services.sla_hours` (which on prod is uniformly 72h for all 92 visible services) or hardcoded 24h fallback if `sla_type='24'`. Policy (`docs/PAYOUT_AND_URGENCY_POLICY.md` §2) requires Standard 48h, VIP 18h, Urgent 4h. Wizard never offers Urgent at all and never charges the 1.3× / 1.6× uplift. The pricing helper `computeOrderPricing` is wired in `order_flow.js` but **not** in the canonical `patient.js` wizard — so urgency tier UX exists in `order_review.ejs` (legacy guest flow) but not in the post-login flow.
*Impact:* patient cannot select VIP or Urgent → platform earns no urgency uplift revenue → doctor sees 72h SLA on every Standard case (which actually buys the doctor more time vs the 48h policy promise — patient-favorable, doctor-favorable, platform loses uplift revenue).
*Fix sketch:* port the `slaChoice → slaHours/urgencyTier` logic from `order_flow.js POST /order/:id/payment` into `patient.js POST /patient/new-case/step4`, including the 7am–7pm Cairo cutoff redirect to `/order/:id/urgency-conflict`.

**P1-PATIENT-2 — Step1 wizard creates a draft `orders` row before the patient picks specialty/service.**
*Evidence:* code-only, `patient.js:1331-1392`. This is by-design (multi-step wizard), but no cleanup job purges abandoned drafts.
*Impact:* `orders` table will accumulate `DRAFT` rows. Cosmetic at low traffic; cumulative at scale.
*Fix sketch:* add a daily worker that hard-deletes drafts older than 30 days with no payment.

**P1-PATIENT-3 — `/portal/patient/payment-return` trusts `?success=true` query param.**
*Evidence:* **VERIFIED-code**, `patient.js:1564-1594`. The `isSuccess` check only redirects to the success page; the success page itself re-queries DB and refuses to flip status without webhook/stub. So the trust boundary is correct **only because** the success page does its own check. Tightly coupled — if a future change makes success-page write status without re-querying, this becomes a CSRF-style spoofing vector. Today: safe.

### Doctor

**P1-DOC-1 — `/portal/doctor/messages` is a "Coming in Phase 2" stub.**
*Evidence:* **VERIFIED-code**, `doctor.js:616-630`. View renders an empty page. Doctors who try to message a patient hit a dead end.
*Impact:* doctors who need to ask a patient something out-of-band fall back to phone/whatsapp, breaking audit trail.
*Fix sketch:* either ship a minimal messages list (read-only initially) or remove the sidebar nav item.

**P1-DOC-2 — `/portal/doctor/earnings` is a "Coming in v1.5" stub.**
*Evidence:* **VERIFIED-code**, `views/portal_doctor_earnings.ejs:13-32`. The view explicitly tells the doctor "fees per case are visible inside each case detail." Combined with P0-FIN-1, doctors never see a monthly statement.
*Impact:* doctors will ask "how do I see my total earnings?" — the answer is "look at every case manually". Bad UX, but not money-losing because the dashboard summary uses `SUM(orders.doctor_fee)` which is correct.
*Fix sketch:* basic earnings page reading `doctor_earnings` (after P0-FIN-1 is wired) + `addon_earnings`, grouped by month.

**P1-DOC-3 — Doctor cannot reset their password via the portal forgot-password form.**
*Evidence:* **VERIFIED-code**, `auth.js:283`: `WHERE email=$1 AND role='patient' AND is_active=true`. Doctors silently fall into the "if an account exists you'll receive a link" branch but no email is sent.
*Impact:* a doctor who forgets their password has no self-serve recovery path; they must contact superadmin (who would need to use the manual reset-link generator at `superadmin.js:2645`).
*Fix sketch:* widen the WHERE clause to `role IN ('patient','doctor') AND is_active=true`. The `password-reset.hbs` template is generic enough to work for doctors.

**P1-DOC-4 — `/portal/doctor` redirects.**
*Evidence:* code-only, `doctor.js:110`. This redirects `/portal/doctor` → `/portal/doctor/today`. Confirmed working but two-step navigation; minor.

### Public / marketing

**P1-PUB-1 — `/blog`, `/faq`, `/specialties` return 404 on prod.**
*Evidence:* **VERIFIED-prod**, three direct curls.
*Impact:* if marketing campaigns or social-media posts link to these slugs, users hit 404 and bounce. April audit also flagged `/blog` (FLAG 2.5) — still unresolved. `public/blog/` directory has 4 production HTML pages but no Express route mounts them.
*Fix sketch:* either mount `app.use('/blog', express.static('public/blog'))` OR remove links from any view that references them. A grep showed no in-tree references to `href="/blog"` etc., but external campaigns may.

**P1-PUB-2 — `/help-me-choose` AI assistant submits to dead `/order/start`.**
*Evidence:* **VERIFIED-code**, `views/help_me_choose.ejs:108`: `const SUBMIT_BASE = '/order/start';`. The page renders fine, the AI chat works, but the final "submit" CTA sends the user to the coming-soon page.
*Impact:* the AI service-finder is a dead-end UX trap. A guest who used it ends up at coming_soon and has no way to convert.
*Fix sketch:* change SUBMIT_BASE to `/register?next=/patient/new-case` (or whichever signed-in entry point applies).

**P1-PUB-3 — `/order/start` hard-renders coming_soon; `service_assistant` partial defaults to it.**
*Evidence:* **VERIFIED-code+prod**, `order_flow.js:115-117` (route returns `coming_soon`); `views/partials/service_assistant.ejs:3` defaults `_saSubmitUrl = '/order/start'`. The floating chat partial is included in `views/services.ejs` and `views/order_start.ejs`.
*Impact:* every page that includes the service-assistant chat has a "submit" path that lands on coming-soon for guests. Logged-in patients never hit `/order/start` (their flow is `/patient/new-case`), so the impact is guests only.
*Fix sketch:* change the default `submitUrl` in `service_assistant.ejs` to `/register?next=/patient/new-case`. Resolve `/order/start` policy explicitly: either revive the legacy guest flow (uncomment `order_flow.js:120-129`) or delete the route + its references.

### Auth

**P1-AUTH-1 — Forgot-password is patient-only.** (cross-listed as P1-DOC-3)

**P1-AUTH-2 — Mobile API OTP code generated with `Math.random()`.**
*Evidence:* **VERIFIED-code**, `routes/api/auth.js:157`: `Math.floor(100000 + Math.random() * 900000)`. Math.random is not cryptographically secure.
*Impact:* an attacker who can predict server entropy could in principle predict the next OTP. In practice mitigated by 10-min TTL + single-use + Twilio Verify primary path. Still: don't ship medical PHI auth on `Math.random`.
*Fix:* `require('crypto').randomInt(100000, 1000000).toString().padStart(6, '0')`.

**P1-AUTH-3 — `/api/v1/auth/login` filters `role='patient'` strictly.**
*Evidence:* **VERIFIED-code**, `api/auth.js:94`. So a doctor cannot log in via the mobile API. Whether this is intentional depends on whether the mobile app is patient-only. If the mobile app ever needs doctor sessions, this is a blocker. UNVERIFIED — flagging.

### Pipelines / data

**P1-NOTIF-1 — Lifecycle email wrappers (`notifyCaseReceived`, `notifyCaseAssigned`, `notifyMoreInfoRequested`, `notifyCaseReassigned`, `notifyCaseCancelled`, `notifyDoctorFileUploaded`) are EN-only hardcoded text.**
*Evidence:* **VERIFIED-code**, `services/emailService.js:482-567`. The function bodies ship plain English strings (`"Hello Doctor,"`, `"Your case X has been received"`) and don't read from the bilingual Handlebars templates. The 6 callers don't pass a `lang` parameter.
*Impact:* AR-language patients/doctors get English emails for these specific lifecycle events. The 14 templated emails (welcome, password-reset, payment-success, case-submitted, case-assigned via template, etc.) ARE bilingual; only these 6 hardcoded wrappers are EN-only.
*Fix sketch:* either route them through `sendEmail({ template, lang })` against the existing `case-submitted.hbs` / `case-assigned.hbs` etc., or duplicate the EN strings as AR.

**P1-DATA-1 — `services.sla_hours` uniformly 72h on prod.**
*Evidence:* **VERIFIED-prod**: `SELECT sla_hours, COUNT(*) FROM services GROUP BY sla_hours` returns `72h: 92` (only).
*Impact:* policy says Standard SLA is 48h. Catalog says 72h. The April-29 plan included "update existing SLA hours: Standard 72h → 48h" — never ran. Patients are promised 72h instead of 48h; doctors get 72h instead of being held to 48h. Patient/doctor-favorable but mis-reps the policy promise.
*Fix:* migration `UPDATE services SET sla_hours = 48 WHERE sla_hours = 72`.

**P1-SCHEMA-1 — Schema drift: `users` has both `country` (text, populated for 4/8 patients) and `country_code` (text, populated for 4/8).**
*Evidence:* **VERIFIED-prod**. Two columns, half-and-half population.
*Impact:* every read of `users.country` vs `users.country_code` could return different values. `routes/auth.js` writes `country_code`; `routes/api/auth.js:60` writes `country`. Cross-flow inconsistency.
*Fix:* pick one (recommend `country_code`), backfill, drop the other.

**P1-SCHEMA-2 — `users.reset_token` and `users.reset_token_expires` columns still on the table.**
*Evidence:* **VERIFIED-prod**. After the password_reset_tokens migration, no code writes these anymore but `api/auth.js:328` still reads them (P0-AUTH-1). Drop after the mobile reset-password fix lands.

### Security / hardening

**P1-SEC-1 — `/superadmin/users/:id/generate-reset-link` returns the token in the HTTP response body.**
*Evidence:* **VERIFIED-code**, `superadmin.js:2676`: `return res.send(\`Reset link: ${url}\`);`. Browser displays the raw reset URL on the superadmin page.
*Impact:* the link is shown to a privileged superadmin (so on the trust boundary, not crossing it). But: any browser cache, screen-recording, screenshot, or person looking over the superadmin's shoulder gets the token. Better UX is "we emailed it to the user" without exposing the link.
*Fix:* call `emailService.sendEmail({ template: 'password-reset', to: user.email, ... })` instead of returning the URL.

---

## P2 — log and move on (polish, debt, minor inconsistencies)

- **P2-CLEANUP-1** — 16 `.bak` files in `src/views/` (`doctor_alerts.ejs.bak` etc.). April audit FLAG 10.3 — still unresolved. None served by Express but they add review noise.
- **P2-CLEANUP-2** — root-level "BRIEF" markdown files (`CLAUDE_CODE_BRIEF*.md`, `LOGO_AND_*FIX.md` etc.) — temp scratch from prior debug sessions. Not deployed; review noise.
- **P2-DEAD-1** — `src/sla_worker.js` already noted dead (April audit FLAG 10.1). Comment in `server.js:104-106` explicitly disables it. Delete the file.
- **P2-DEAD-2** — `src/migrations/020_orders_paid_at.sql` is superseded by `032_orders_paid_at.sql`. Both ran on prod. 020 should be a no-op marker or be deleted (with `schema_migrations` row left in place).
- **P2-MIG-1** — Migration numbering gap: no `029_*.sql` exists. Cosmetic.
- **P2-LOG-1** — 9 `console.log` calls in `src/routes/`. Most are info-level (paymob-return query, contact-form message preview, doctor SLA dashboard sample). None leak PHI directly, but `static-pages.js:89/138` print contact-form name+email and lead name+email to logs, mild PII leakage. Move to `verbose()` from `logger.js` to suppress in production.
- **P2-CSRF-1** — exempt list in `csrf.js:83` is a hardcoded path-prefix list. Adding new webhooks will require touching the middleware. Consider per-route opt-in via `router.post('/callback', csrfExempt, …)` pattern.
- **P2-CSP-1** — homepage CSP `script-src` includes `https://media.twiliocdn.com` — verify it's still needed (Twilio Verify call is server-side; no Twilio JS on homepage AFAICT).
- **P2-COOKIE-1** — `Set-Cookie: lang=en` appears twice on `GET /login` response (curl shows two identical headers). Cosmetic.
- **P2-LANG-1** — April audit 9.4: `/lang/ar` redirects unauth visitors to `/login` instead of localizing the public site. Re-flag, no curl re-test.
- **P2-PRELAUNCH-1** — `order_flow.js:51` constant `PRE_LAUNCH_MODE = false` and the dead `if (PRE_LAUNCH_MODE)` block above the route are vestigial (the actual coming-soon is hardcoded one route below). Delete after deciding `/order/start` policy.
- **P2-TODO-1** — `doctor.js:3125` TODO comment about SLA-minutes fields on dashboard. Non-blocking.
- **P2-PAYMOB-1** — legacy fallback `PAYMENT_WEBHOOK_SECRET` still honored at `payments.js:42-58`. Retire once HMAC is the only path (April audit FLAG 4.7).
- **P2-RATELIMIT-1** — `authLimiter` rate is 30/15min/IP per April audit. Tighten to 10/15min or add per-account lockout (April audit FLAG 6.4).
- **P2-PG-1** — `src/pg.js:29` uses `rejectUnauthorized:false` (April audit FLAG 6.6). MITM-vulnerable on prod connections; fix with Supabase CA cert.
- **P2-OPS-1** — `/ops/agent/ping`, `/ops/agent/log-tokens` are CSRF-exempt (`csrf.js:86-99`). They have their own auth model (UNVERIFIED in this audit). Worth a focused review post-launch.

---

## INFO — observations, no action required

- **INFO-EMAIL-1** — Resend integration looks well-done: SDK adapter preserves nodemailer shape, recipientGuard wraps every send, batch-safe filtering, blocked attempts logged to `blocked_send_attempts` table. EN+AR templates symmetric (20 each).
- **INFO-PRICE-1** — Production catalog: 92 visible services, **all** at exactly `doctor_fee = base_price × 0.20` (verified). 95 hidden services have NULL pricing. Closes April audit B4 / FLAG 7.6 false-positive permanently.
- **INFO-ADDON-1** — addon_services on prod: prescription = 50% commission ✓, video_consult = 85% ✓ — matches `PAYOUT_AND_URGENCY_POLICY` §1.
- **INFO-MULT-1** — All 92 visible services have `vip_multiplier=1.30, urgent_multiplier=1.60` ✓. Migration 027 verified applied.
- **INFO-SEC-1** — Production security headers tight: CSP with nonce, X-Frame-Options DENY (homepage)/SAMEORIGIN (login), HSTS preload-eligible, Permissions-Policy locked. CSRF mode = enforce (verified by 403 on `POST /register` without token).
- **INFO-DEPLOY-1** — Prod is on `ebbfd51` per `/__version`. Local HEAD is also `ebbfd51`. Working tree is clean. Deploy is up-to-date with main as of audit start.
- **INFO-DB-1** — Prod has 1 active doctor, 8 patients (mostly seed), 3 orders (none paid). The first paid order in production will be a system shake-out.

---

## Launch readiness summary

1. **Verdict: NO-GO until P0-PAY-1 is fixed.** Every Paymob webhook hits HTTP 403 today. The first patient who pays will be charged real money and the system will not know. Diagnosis to fix is one line in `src/middleware/csrf.js:83`.

2. **P0-FIN-1 is also a no-launch item** if you care about the platform-side accounting being right on day 1. The doctor isn't shortchanged, but admin pending-payouts will say 0 forever for main-case revenue. Wiring `computeDoctorEarnings` at three known sites is a small, well-scoped fix.

3. **P0-SEC-1 (temp password to logs)** is a P0 only if you treat Render logs as untrusted. Either fix today (~30 min — wire emailService to the create-doctor flow) or accept the risk for the small set of doctors you'll create manually pre-launch and rotate their passwords.

4. **P0-AUTH-1 (mobile API reset-password)** is dormant unless the mobile app actually calls that endpoint. Confirm with the mobile team. If they don't, downgrade to P1.

5. **The biggest practical UX risk after P0-PAY-1** is P1-PATIENT-1: the canonical patient wizard never offers VIP or Urgent and always uses 72h SLA. You launch with the policy promise of 1.0×/1.3×/1.6× and 48h/18h/4h, but the system charges 1.0× and promises 72h. You can launch and fix this in week 1, or fix before launch and charge correctly from order #1 — your call.

6. **Doctor-facing UX risks**: forgot-password locks doctors out (P1-DOC-3), `/portal/doctor/earnings` is a stub that says "Coming in v1.5" (P1-DOC-2), `/portal/doctor/messages` is a stub (P1-DOC-1). None of these stop a doctor from accepting cases and writing reports. They're support-ticket generators, not launch blockers.

7. **Marketing 404s** (P1-PUB-1: `/blog`, `/faq`, `/specialties`) — only matters if external traffic links to them. Internal views don't.

8. **Migration housekeeping** (duplicate `paid_at` migration files, gap in numbering, schema drift on `users.country` vs `country_code`, orphan `users.reset_token` columns) — not blockers, but the `country` drift will bite when someone writes a query joining on the wrong column. Schedule for week 1.

9. **What I did not verify (UNVERIFIED items, in priority order):**
   - End-to-end real Paymob test transaction (impossible without Paymob test cards — would prove P0-PAY-1 in vivo).
   - Authenticated patient + doctor portal walks (browser, both EN and AR).
   - SLA breach refund refunds **uplift only** with the policy arithmetic (no breached cases on prod to sample).
   - PDF report bilingual rendering.
   - Whether the mobile app calls `/api/v1/auth/reset-password` (would confirm P0-AUTH-1 severity).
   - `/lang/ar` unauth public-site behavior (re-confirm April audit 9.4).
   - Notification friendly-title mapping covers every event template.

10. **Minimum set of fixes I would want before accepting real patients tomorrow:**
    1. **P0-PAY-1** — change CSRF exempt path (1 line). **Mandatory.**
    2. **P0-SEC-1** — replace `console.log` of temp password with email send (~30 min). **Strongly recommended.**
    3. **P1-DOC-3** — let doctors reset their password (1 WHERE-clause widen, ~5 min). **Strongly recommended.**
    4. **P1-PUB-2 / P1-PUB-3** — fix `/help-me-choose` and `service_assistant` to point at `/register?next=/patient/new-case` (~10 min). **Strongly recommended** so guest funnel doesn't dead-end.
    5. **P0-FIN-1** — wire `computeDoctorEarnings` at order-creation + completion + breach. **Estimated 2-3 hours of focused work** including a regression test against the policy worked-example E. Defer if you're willing to live with broken admin payouts for week 1.
    6. **P1-PATIENT-1** — port urgency-tier UX from `order_flow.js` into `patient.js` wizard step4. **Estimated 3-4 hours** including the 7am-7pm Cairo cutoff handling. Defer if you're willing to launch at Standard-only pricing.

**Estimated time to fix all four mandatory + strongly-recommended P0/P1 items: ~1 hour.**

**Estimated time to fix the full P0 set (including P0-FIN-1 wiring): ~3-4 hours.**

**Verdict: GO-WITH-FIXES.** Fix P0-PAY-1, P0-SEC-1, P1-DOC-3, P1-PUB-2/3 today. Fix P0-FIN-1 tomorrow if at all possible (broken accounting on launch day is recoverable but uncomfortable). Treat P1-PATIENT-1 as the first week-1 follow-up.

---

## Appendix A — production curl probes (raw HTTP status)

```
GET /                       → 200
GET /healthz                → 200 (JSON OK)
GET /__version              → 200 (git_sha=ebbfd51)
GET /login                  → 200
GET /register               → 200
GET /forgot-password        → 200
GET /about                  → 200
GET /contact                → 200
GET /services               → 200
GET /privacy, /terms        → 200
GET /how-it-works           → 200 (anchor /#how-it-works)
GET /blog                   → 404
GET /faq                    → 404
GET /specialties            → 404
GET /help-me-choose         → 200
GET /order/start            → 200 (renders coming_soon)
GET /coming-soon            → 200
GET /doctor/login           → 200
GET /doctor/signup          → 200
GET /dashboard              → 302 → /login?next=/dashboard
GET /portal/doctor          → 302 → /login?next=/portal/doctor
GET /superadmin             → 302 → /login?next=/superadmin
GET /admin                  → 302 → /login?next=/admin
GET /patient/new-case       → 302 → /login?next=/patient/new-case
GET /ops/login              → 200
POST /payments/callback     → 403  ← P0-PAY-1
POST /callback              → 404
POST /payments/webhook      → 404
POST /register (no CSRF)    → 403  ← CSRF enforce ✓
POST /api/v1/auth/login     → 401
GET /api/v1/services        → 401
```

## Appendix B — production SQL spot checks (read-only, Supabase pooler)

```
SELECT current_database(), current_user, current_setting('server_version');
  postgres / postgres / 17.6

SELECT COUNT(*) FROM schema_migrations;                              → 33

SELECT COUNT(*) FROM services WHERE COALESCE(is_visible,true)=true;  → 92
SELECT pct, COUNT(*) FROM ... GROUP BY pct;                          → 20.0% : 92  (uniform)
SELECT COUNT(*) FROM services WHERE doctor_fee >= base_price;        → 0  (no inverted rows)

SELECT COUNT(*) FROM services WHERE COALESCE(is_visible,true)=true GROUP BY sla_hours;
  72h : 92                                                            ← P1-DATA-1

SELECT vip_multiplier, urgent_multiplier, COUNT(*) FROM services
 WHERE COALESCE(is_visible,true)=true GROUP BY ...;
  vip=1.30 urgent=1.60 : 92                                           ✓

SELECT id, doctor_commission_pct FROM addon_services;
  prescription : 50                                                    ✓
  video_consult : 85                                                   ✓

SELECT COUNT(*) FROM users WHERE role='doctor' GROUP BY pending_approval, is_active;
  pending=0 active=1 inactive=0

SELECT COUNT(*) FROM orders;                                         → 3
  status: expired_unpaid (2), cancelled (1), paid (0)

SELECT COUNT(*) FROM doctor_earnings;                                → 0
SELECT COUNT(*) FROM addon_earnings;                                 → 0
SELECT COUNT(*) FROM order_addons;                                   → 0
SELECT COUNT(*) FROM refunds;                                        → 0

SELECT COUNT(*) FROM information_schema.columns
 WHERE table_name='orders' AND column_name='paid_at';                → 1 (no duplicate)

SELECT COUNT(*) FILTER (WHERE country IS NOT NULL AND country_code IS NULL) AS only_country,
       COUNT(*) FILTER (WHERE country IS NULL AND country_code IS NOT NULL) AS only_cc,
       COUNT(*) FILTER (WHERE country IS NOT NULL AND country_code IS NOT NULL) AS both
  FROM users WHERE role='patient';
  only_country=4, only_cc=0, both=4                                  ← P1-SCHEMA-1
```

---

## Appendix C — file:line citation index

Pinned references for fast triage:

| Finding | Primary cite |
|---|---|
| P0-PAY-1 | `src/middleware/csrf.js:83`, `src/server.js:655`, `src/routes/payments.js:39`, `src/routes/patient.js:1542` |
| P0-FIN-1 | `src/services/earnings_calc.js:40-68`, `src/routes/doctor.js:1894`, `src/routes/video.js:805,988`, `src/video_scheduler.js:128` |
| P0-AUTH-1 | `src/routes/api/auth.js:327-338`, `TODO.md` "Stranded, discovered 2026-04-30" |
| P0-SEC-1 | `src/routes/superadmin.js:1972-1974` |
| P1-PATIENT-1 | `src/routes/patient.js:1500,1807-1813`, `src/routes/order_flow.js:431-434,441-461` |
| P1-DOC-1 | `src/routes/doctor.js:616-630` |
| P1-DOC-2 | `src/routes/doctor.js:633-647`, `src/views/portal_doctor_earnings.ejs:13-32` |
| P1-DOC-3 | `src/routes/auth.js:283` |
| P1-PUB-1 | curl + `public/blog/`, no Express mount |
| P1-PUB-2 | `src/views/help_me_choose.ejs:108` |
| P1-PUB-3 | `src/routes/order_flow.js:115-117`, `src/views/partials/service_assistant.ejs:3` |
| P1-AUTH-2 | `src/routes/api/auth.js:157` |
| P1-AUTH-3 | `src/routes/api/auth.js:94` |
| P1-NOTIF-1 | `src/services/emailService.js:482-567` |
| P1-DATA-1 | prod SQL, `src/migrations/` (no Standard-48h migration ran) |
| P1-SCHEMA-1 | prod SQL, `src/routes/auth.js` vs `src/routes/api/auth.js:60` |
| P1-SCHEMA-2 | prod SQL, `src/routes/api/auth.js:328` |
| P1-SEC-1 | `src/routes/superadmin.js:2676` |

---

*End of report.*
